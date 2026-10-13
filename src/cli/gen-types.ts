import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import pg from 'pg'

interface PgTypeRow {
  oid: number
  typname: string
  typtype: string
  typbasetype: number
  typelem: number
  typcategory: string
  typrelid: number
}

interface RelationRow {
  schema: string
  name: string
  relkind: string
}

interface ResolveCtx {
  types: Map<number, PgTypeRow>
  relations: Map<number, RelationRow>
}

interface ColumnInfo {
  schema: string
  name: string
  typeOid: number
  notNull: boolean
  hasDefault: boolean
  identity: boolean
  generated: boolean
  comment: string | null
}

interface EnumInfo {
  schema: string
  name: string
  values: string[]
}

interface CompositeInfo {
  schema: string
  name: string
  attributes: { name: string; typeOid: number }[]
}

interface RawFunction {
  schema: string
  name: string
  argNames: string[]
  inArgTypes: number[]
  returnType: number
  returnsSet: boolean
}

interface RelationshipInfo {
  schema: string
  table: string
  foreignKeyName: string
  columns: string[]
  isOneToOne: boolean
  referencedRelation: string
  referencedColumns: string[]
}

const SCALAR_TYPES: Record<string, string> = {
  int2: 'number',
  int4: 'number',
  int8: 'number',
  float4: 'number',
  float8: 'number',
  numeric: 'number',
  money: 'number',
  oid: 'number',
  bool: 'boolean',
  json: 'Json',
  jsonb: 'Json',
  text: 'string',
  varchar: 'string',
  bpchar: 'string',
  char: 'string',
  name: 'string',
  uuid: 'string',
  date: 'string',
  time: 'string',
  timetz: 'string',
  timestamp: 'string',
  timestamptz: 'string',
  interval: 'string',
  inet: 'string',
  cidr: 'string',
  macaddr: 'string',
  macaddr8: 'string',
  bytea: 'string',
  xml: 'string',
  bit: 'string',
  varbit: 'string',
  tsvector: 'string',
  tsquery: 'string',
  point: 'string',
  line: 'string',
  lseg: 'string',
  box: 'string',
  path: 'string',
  polygon: 'string',
  circle: 'string',
  void: 'void',
  record: 'Json',
}

/** Resolve a pg type OID into a TypeScript type usable inside `Database`. */
function resolveType(oid: number, schema: string, ctx: ResolveCtx): string {
  const t = ctx.types.get(oid)
  if (!t) return 'unknown'
  if (t.typcategory === 'A' && t.typelem !== 0) {
    return `(${resolveType(t.typelem, schema, ctx)})[]`
  }
  if (t.typtype === 'd' && t.typbasetype !== 0) {
    return resolveType(t.typbasetype, schema, ctx)
  }
  if (t.typtype === 'e') return `Database["${schema}"]["Enums"]["${t.typname}"]`
  if (t.typtype === 'c') {
    const rel = ctx.relations.get(t.typrelid)
    if (rel && (rel.relkind === 'v' || rel.relkind === 'm')) {
      return `Database["${rel.schema}"]["Views"]["${rel.name}"]["Row"]`
    }
    if (rel && rel.relkind !== 'c') {
      return `Database["${rel.schema}"]["Tables"]["${rel.name}"]["Row"]`
    }
    if (rel) return `Database["${rel.schema}"]["CompositeTypes"]["${rel.name}"]`
    return 'Json'
  }
  return SCALAR_TYPES[t.typname] ?? 'unknown'
}

function jsString(value: string): string {
  return JSON.stringify(value)
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : jsString(key)
}

function renderStringArray(values: string[]): string {
  return `[${values.map(jsString).join(', ')}]`
}

function renderRelationship(rel: RelationshipInfo): string[] {
  return [
    '          {',
    `            foreignKeyName: ${jsString(rel.foreignKeyName)}`,
    `            columns: ${renderStringArray(rel.columns)}`,
    `            isOneToOne: ${rel.isOneToOne}`,
    `            referencedRelation: ${jsString(rel.referencedRelation)}`,
    `            referencedColumns: ${renderStringArray(rel.referencedColumns)}`,
    '          },',
  ]
}

class Introspector {
  constructor(private readonly pool: pg.Pool, private readonly schemas: string[]) {}

  async loadTypes(): Promise<{ types: Map<number, PgTypeRow>; relations: Map<number, RelationRow> }> {
    const types = new Map<number, PgTypeRow>()
    const typeRes = await this.pool.query<PgTypeRow>(
      `SELECT t.oid, t.typname, t.typtype, t.typbasetype, t.typelem, t.typcategory, t.typrelid
       FROM pg_type t`
    )
    for (const row of typeRes.rows) types.set(Number(row.oid), { ...row, oid: Number(row.oid) })

    const relations = new Map<number, RelationRow>()
    const relRes = await this.pool.query<{ oid: number; schema: string; name: string; relkind: string }>(
      `SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`
    )
    for (const row of relRes.rows) relations.set(Number(row.oid), row)
    return { types, relations }
  }

  async loadEnums(): Promise<Map<string, EnumInfo>> {
    const res = await this.pool.query<{ schema: string; name: string; labels: string[] }>(
      `SELECT n.nspname AS schema, t.typname AS name,
              array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typtype = 'e' AND n.nspname = ANY($1)
       GROUP BY n.nspname, t.typname
       ORDER BY n.nspname, t.typname`,
      [this.schemas]
    )
    const out = new Map<string, EnumInfo>()
    for (const row of res.rows) {
      out.set(`${row.schema}.${row.name}`, { schema: row.schema, name: row.name, values: row.labels })
    }
    return out
  }

  async loadComposites(): Promise<Map<string, CompositeInfo>> {
    const res = await this.pool.query<{ schema: string; name: string; attr: string; type_oid: number }>(
      `SELECT n.nspname AS schema, t.typname AS name, a.attname AS attr, a.atttypid AS type_oid
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE t.typtype = 'c' AND n.nspname = ANY($1)
       ORDER BY n.nspname, t.typname, a.attnum`,
      [this.schemas]
    )
    const out = new Map<string, CompositeInfo>()
    for (const row of res.rows) {
      const key = `${row.schema}.${row.name}`
      let entry = out.get(key)
      if (!entry) {
        entry = { schema: row.schema, name: row.name, attributes: [] }
        out.set(key, entry)
      }
      entry.attributes.push({ name: row.attr, typeOid: Number(row.type_oid) })
    }
    return out
  }

  async loadColumns(): Promise<{ tables: Map<string, ColumnInfo[]>; views: Map<string, ColumnInfo[]> }> {
    const res = await this.pool.query<{
      schema: string
      table: string
      kind: string
      name: string
      type_oid: number
      not_null: boolean
      has_default: boolean
      identity: boolean
      generated: boolean
      comment: string | null
    }>(
      `SELECT n.nspname AS schema, c.relname AS table, c.relkind AS kind,
              a.attname AS name, a.atttypid AS type_oid,
              a.attnotnull AS not_null,
              (ad.adbin IS NOT NULL) AS has_default,
              (a.attidentity <> '') AS identity,
              (a.attgenerated <> '') AS generated,
              d.description AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND n.nspname = ANY($1)
       ORDER BY n.nspname, c.relname, a.attnum`,
      [this.schemas]
    )
    const tables = new Map<string, ColumnInfo[]>()
    const views = new Map<string, ColumnInfo[]>()
    for (const row of res.rows) {
      const col: ColumnInfo = {
        schema: row.schema,
        name: row.name,
        typeOid: Number(row.type_oid),
        notNull: row.not_null,
        hasDefault: row.has_default,
        identity: row.identity,
        generated: row.generated,
        comment: row.comment,
      }
      const target = row.kind === 'v' || row.kind === 'm' ? views : tables
      const key = `${row.schema}.${row.table}`
      const list = target.get(key) ?? []
      list.push(col)
      target.set(key, list)
    }
    return { tables, views }
  }

  async loadRelationships(): Promise<Map<string, RelationshipInfo[]>> {
    const res = await this.pool.query<{
      schema: string
      table: string
      constraint_name: string
      columns: string[]
      referenced_table: string
      referenced_columns: string[]
      is_one_to_one: boolean
    }>(
      `SELECT n.nspname AS schema, src.relname AS table, c.conname AS constraint_name,
              ARRAY(
                SELECT att.attname FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
                ORDER BY u.ord
              )::text[] AS columns,
              dst.relname AS referenced_table,
              ARRAY(
                SELECT att.attname FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
                ORDER BY u.ord
              )::text[] AS referenced_columns,
              EXISTS (
                SELECT 1 FROM pg_constraint uc
                WHERE uc.conrelid = c.conrelid AND uc.contype IN ('p', 'u')
                  AND uc.conkey @> c.conkey AND c.conkey @> uc.conkey
              ) OR EXISTS (
                SELECT 1 FROM pg_index i
                WHERE i.indrelid = c.conrelid AND i.indisunique
                  AND i.indkey::int2[] @> c.conkey AND c.conkey @> i.indkey::int2[]
              ) AS is_one_to_one
       FROM pg_constraint c
       JOIN pg_class src ON src.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = src.relnamespace
       JOIN pg_class dst ON dst.oid = c.confrelid
       WHERE c.contype = 'f' AND n.nspname = ANY($1)
       ORDER BY n.nspname, src.relname, c.conname`,
      [this.schemas]
    )
    const out = new Map<string, RelationshipInfo[]>()
    for (const row of res.rows) {
      const key = `${row.schema}.${row.table}`
      const list = out.get(key) ?? []
      list.push({
        schema: row.schema,
        table: row.table,
        foreignKeyName: row.constraint_name,
        columns: row.columns,
        isOneToOne: row.is_one_to_one,
        referencedRelation: row.referenced_table,
        referencedColumns: row.referenced_columns,
      })
      out.set(key, list)
    }
    return out
  }

  async loadFunctions(): Promise<Map<string, RawFunction>> {
    const res = await this.pool.query<{
      schema: string
      name: string
      arg_names: string[] | null
      in_arg_types: number[]
      return_type: number
      returns_set: boolean
    }>(
      `SELECT n.nspname AS schema, p.proname AS name,
              p.proargnames::text[] AS arg_names,
              p.proargtypes::oid[] AS in_arg_types,
              p.prorettype AS return_type,
              p.proretset AS returns_set
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY($1) AND p.prokind = 'f'
       ORDER BY n.nspname, p.proname`,
      [this.schemas]
    )
    const out = new Map<string, RawFunction>()
    for (const row of res.rows) {
      const key = `${row.schema}.${row.name}`
      if (out.has(key)) continue
      out.set(key, {
        schema: row.schema,
        name: row.name,
        argNames: row.arg_names ?? [],
        inArgTypes: (row.in_arg_types ?? []).map(Number),
        returnType: Number(row.return_type),
        returnsSet: row.returns_set,
      })
    }
    return out
  }
}

interface RenderInput {
  schemas: string[]
  ctx: ResolveCtx
  tables: Map<string, ColumnInfo[]>
  views: Map<string, ColumnInfo[]>
  enums: Map<string, EnumInfo>
  composites: Map<string, CompositeInfo>
  functions: Map<string, RawFunction>
  relationships: Map<string, RelationshipInfo[]>
}

function sortedKeys<T>(map: Map<string, T>): string[] {
  return [...map.keys()].sort()
}

function render(input: RenderInput): string {
  const out: string[] = []
  out.push('export type Json =')
  out.push('  | string')
  out.push('  | number')
  out.push('  | boolean')
  out.push('  | null')
  out.push('  | { [key: string]: Json | undefined }')
  out.push('  | Json[]')
  out.push('')
  out.push('export type Database = {')
  for (const schema of input.schemas) {
    out.push(`  ${quoteKey(schema)}: {`)
    renderTables(out, schema, input)
    renderViews(out, schema, input)
    renderFunctions(out, schema, input)
    renderEnums(out, schema, input)
    renderCompositeTypes(out, schema, input)
    out.push('  }')
  }
  out.push('}')
  out.push('')
  const defaultSchema = input.schemas.includes('public') ? 'public' : (input.schemas[0] ?? 'public')
  const defaultKey = `'${defaultSchema.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  out.push('export type Tables<')
  out.push(`  T extends keyof Database[${defaultKey}]['Tables'] = keyof Database[${defaultKey}]['Tables'],`)
  out.push(`> = Database[${defaultKey}]['Tables'][T]['Row']`)
  return out.join('\n') + '\n'
}

function renderTables(out: string[], schema: string, input: RenderInput): void {
  const keys = sortedKeys(input.tables).filter((k) => k.startsWith(`${schema}.`))
  out.push('    Tables: {')
  if (keys.length === 0) out.push('      [_ in never]: never')
  for (const key of keys) {
    const name = key.slice(schema.length + 1)
    const cols = input.tables.get(key)!
    const rels = input.relationships.get(key) ?? []
    out.push(`      ${quoteKey(name)}: {`)
    out.push('        Row: {')
    for (const col of cols) {
      const ts = resolveType(col.typeOid, col.schema, input.ctx)
      out.push(`          ${quoteKey(col.name)}: ${ts}${col.notNull ? '' : ' | null'}`)
    }
    out.push('        }')
    out.push('        Insert: {')
    for (const col of cols) {
      if (col.generated) continue
      const optional = col.identity || col.hasDefault || !col.notNull
      const ts = resolveType(col.typeOid, col.schema, input.ctx)
      out.push(
        `          ${quoteKey(col.name)}${optional ? '?' : ''}: ${ts}${col.notNull ? '' : ' | null'}`
      )
    }
    out.push('        }')
    out.push('        Update: {')
    for (const col of cols) {
      if (col.generated) continue
      const ts = resolveType(col.typeOid, col.schema, input.ctx)
      out.push(`          ${quoteKey(col.name)}?: ${ts}${col.notNull ? '' : ' | null'}`)
    }
    out.push('        }')
    if (rels.length === 0) {
      out.push('        Relationships: []')
    } else {
      out.push('        Relationships: [')
      for (const rel of rels) out.push(...renderRelationship(rel))
      out.push('        ]')
    }
    out.push('      }')
  }
  out.push('    }')
}

function renderViews(out: string[], schema: string, input: RenderInput): void {
  const keys = sortedKeys(input.views).filter((k) => k.startsWith(`${schema}.`))
  out.push('    Views: {')
  if (keys.length === 0) out.push('      [_ in never]: never')
  for (const key of keys) {
    const name = key.slice(schema.length + 1)
    const cols = input.views.get(key)!
    const rels = input.relationships.get(key) ?? []
    out.push(`      ${quoteKey(name)}: {`)
    out.push('        Row: {')
    for (const col of cols) {
      const ts = resolveType(col.typeOid, col.schema, input.ctx)
      out.push(`          ${quoteKey(col.name)}: ${ts}${col.notNull ? '' : ' | null'}`)
    }
    out.push('        }')
    if (rels.length === 0) {
      out.push('        Relationships: []')
    } else {
      out.push('        Relationships: [')
      for (const rel of rels) out.push(...renderRelationship(rel))
      out.push('        ]')
    }
    out.push('      }')
  }
  out.push('    }')
}

function renderFunctions(out: string[], schema: string, input: RenderInput): void {
  const keys = sortedKeys(input.functions).filter((k) => k.startsWith(`${schema}.`))
  out.push('    Functions: {')
  if (keys.length === 0) out.push('      [_ in never]: never')
  for (const key of keys) {
    const fn = input.functions.get(key)!
    const args = fn.inArgTypes
      .map((oid, i) => `${quoteKey(fn.argNames[i] ?? `arg${i + 1}`)}: ${resolveType(oid, fn.schema, input.ctx)}`)
      .join('; ')
    const ret = resolveType(fn.returnType, fn.schema, input.ctx)
    const returns = fn.returnsSet ? `(${ret})[]` : ret
    out.push(`      ${quoteKey(fn.name)}: {`)
    out.push(fn.inArgTypes.length === 0 ? '        Args: Record<PropertyKey, never>' : `        Args: { ${args} }`)
    out.push(`        Returns: ${returns}`)
    out.push('      }')
  }
  out.push('    }')
}

function renderEnums(out: string[], schema: string, input: RenderInput): void {
  const keys = sortedKeys(input.enums).filter((k) => k.startsWith(`${schema}.`))
  out.push('    Enums: {')
  if (keys.length === 0) out.push('      [_ in never]: never')
  for (const key of keys) {
    const e = input.enums.get(key)!
    out.push(`      ${quoteKey(e.name)}: ${e.values.map(jsString).join(' | ')}`)
  }
  out.push('    }')
}

function renderCompositeTypes(out: string[], schema: string, input: RenderInput): void {
  const keys = sortedKeys(input.composites).filter((k) => k.startsWith(`${schema}.`))
  out.push('    CompositeTypes: {')
  if (keys.length === 0) out.push('      [_ in never]: never')
  for (const key of keys) {
    const c = input.composites.get(key)!
    out.push(`      ${quoteKey(c.name)}: {`)
    for (const attr of c.attributes) {
      out.push(`        ${quoteKey(attr.name)}: ${resolveType(attr.typeOid, c.schema, input.ctx)} | null`)
    }
    out.push('      }')
  }
  out.push('    }')
}

export interface GenTypesOptions {
  connection: string
  schemas: string[]
  comments?: boolean
}

/** Introspect `connection` and return generated TypeScript source. */
export async function generateTypes(options: GenTypesOptions): Promise<string> {
  const pool = new pg.Pool({ connectionString: options.connection })
  try {
    const introspector = new Introspector(pool, options.schemas)
    const { types, relations } = await introspector.loadTypes()
    const ctx: ResolveCtx = { types, relations }
    const [enums, composites, { tables, views }, relationships, functions] = await Promise.all([
      introspector.loadEnums(),
      introspector.loadComposites(),
      introspector.loadColumns(),
      introspector.loadRelationships(),
      introspector.loadFunctions(),
    ])
    const source = render({ schemas: options.schemas, ctx, tables, views, enums, composites, functions, relationships })
    const header =
      options.comments === false
        ? ''
        : `// Auto-generated by pg-fluent gen-types. Do not edit.\n// Generated at ${new Date().toISOString()}\n\n`
    return header + source
  } finally {
    await pool.end()
  }
}

/** CLI entry point. Throws on failure (the caller maps it to a non-zero exit). */
export async function runGenTypes(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      connection: { type: 'string' },
      schema: { type: 'string', multiple: true },
      out: { type: 'string' },
      'no-comments': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const connection = values.connection ?? process.env['DATABASE_URL']
  if (!connection) {
    throw new Error('A connection string is required (--connection <url> or DATABASE_URL)')
  }
  const schemas = values.schema && values.schema.length > 0 ? [...values.schema].sort() : ['public']
  try {
    const source = await generateTypes({
      connection,
      schemas,
      comments: values['no-comments'] !== true,
    })
    if (values.out) {
      await writeFile(values.out, source, 'utf8')
    } else {
      process.stdout.write(source)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message.replaceAll(connection, '***'))
  }
}
