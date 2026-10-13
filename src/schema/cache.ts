import type { Executor } from '../exec/executor.js'

export interface ColumnInfo {
  name: string
  hasDefault: boolean
  /** Raw `column_default` expression text, or `null` when the column has no default. */
  defaultExpr: string | null
  generated: boolean
  identity: boolean
  nullable: boolean
}

export interface TableInfo {
  schema: string
  name: string
  columns: ColumnInfo[]
  primaryKey: string[]
}

export interface ForeignKeyInfo {
  /** Constraint name, usable as an embedding hint (`!fk_name`). */
  constraint: string
  sourceSchema: string
  sourceTable: string
  /** Columns in `sourceTable` (the referencing side). */
  columns: string[]
  referencedSchema: string
  referencedTable: string
  /** Columns in `referencedTable`. */
  referencedColumns: string[]
}

export interface FunctionArgInfo {
  /** Argument name; `undefined` for unnamed positional arguments. */
  name?: string
  /** Formatted SQL type, e.g. `integer` or `text[]`. */
  type: string
  hasDefault: boolean
}

export interface FunctionInfo {
  schema: string
  name: string
  /** The function returns a set of rows. */
  returnsSet: boolean
  /** `table`/`composite` rows vs a single `scalar`. */
  returnsRows: boolean
  /** Input arguments in declaration order (IN, INOUT and VARIADIC). */
  args: FunctionArgInfo[]
  volatility: 'immutable' | 'stable' | 'volatile'
}

const COLUMNS_SQL = `
SELECT column_name AS name,
       (column_default IS NOT NULL) AS has_default,
       column_default AS default_expr,
       (is_generated = 'ALWAYS') AS generated,
       (is_identity = 'YES') AS identity,
       (is_nullable = 'YES') AS nullable
FROM information_schema.columns
WHERE table_schema = $1 AND table_name = $2
ORDER BY ordinal_position`

const PRIMARY_KEY_SQL = `
SELECT a.attname AS name
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
WHERE i.indrelid = format('%I.%I', $1::text, $2::text)::regclass AND i.indisprimary
ORDER BY array_position(i.indkey, a.attnum)`

const FUNCTIONS_SQL = `
SELECT p.proname AS name,
       p.proretset AS returns_set,
       p.provolatile AS volatility,
       p.pronargdefaults AS n_defaults,
       p.proargnames AS arg_names,
       p.proargmodes AS arg_modes,
       string_to_array(p.proargtypes::text, ' ')::oid[] AS in_arg_types,
       p.proallargtypes AS all_arg_types,
       t.typtype AS return_typtype
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_type t ON t.oid = p.prorettype
WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'f'
ORDER BY p.oid`

const TYPE_NAMES_SQL = `
SELECT oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY ($1::oid[])`

const FOREIGN_KEYS_SQL = `
SELECT con.conname AS constraint,
       sn.nspname AS source_schema,
       sc.relname AS source_table,
       rn.nspname AS referenced_schema,
       rc.relname AS referenced_table,
       (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
       (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS referenced_columns
FROM pg_constraint con
JOIN pg_class sc ON sc.oid = con.conrelid
JOIN pg_namespace sn ON sn.oid = sc.relnamespace
JOIN pg_class rc ON rc.oid = con.confrelid
JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE con.contype = 'f'
  AND ((sn.nspname = $1 AND sc.relname = $2) OR (rn.nspname = $1 AND rc.relname = $2))`

function volatilityOf(code: string): FunctionInfo['volatility'] {
  if (code === 'i') return 'immutable'
  if (code === 's') return 'stable'
  return 'volatile'
}

/** Lazily-loaded, cached catalog lookups for the exposed schemas. */
export class SchemaCache {
  private readonly tables = new Map<string, Promise<TableInfo | undefined>>()
  private readonly functions = new Map<string, Promise<FunctionInfo[]>>()
  private readonly foreignKeys = new Map<string, Promise<ForeignKeyInfo[]>>()

  constructor(private readonly executor: Executor) {}

  getTable(schema: string, table: string): Promise<TableInfo | undefined> {
    const key = `${schema}.${table}`
    let entry = this.tables.get(key)
    if (!entry) {
      entry = this.cacheOrLoad(this.tables, key, () => this.loadTable(schema, table))
    }
    return entry
  }

  /** All overloads of `schema.name` (empty when the function does not exist). */
  getFunction(schema: string, name: string): Promise<FunctionInfo[]> {
    const key = `${schema}.${name}`
    let entry = this.functions.get(key)
    if (!entry) {
      entry = this.cacheOrLoad(this.functions, key, () => this.loadFunctions(schema, name))
    }
    return entry
  }

  /** All foreign keys where `schema.table` is either side. */
  getForeignKeys(schema: string, table: string): Promise<ForeignKeyInfo[]> {
    const key = `${schema}.${table}`
    let entry = this.foreignKeys.get(key)
    if (!entry) {
      entry = this.cacheOrLoad(this.foreignKeys, key, () => this.loadForeignKeys(schema, table))
    }
    return entry
  }

  /**
   * Memoise an async catalog load, evicting the entry if the load rejects so a
   * transient failure does not poison the cache forever.
   */
  private cacheOrLoad<T>(
    store: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>
  ): Promise<T> {
    const entry = load().catch((err: unknown) => {
      if (store.get(key) === entry) store.delete(key)
      throw err
    })
    store.set(key, entry)
    return entry
  }

  clear(): void {
    this.tables.clear()
    this.functions.clear()
    this.foreignKeys.clear()
  }

  refresh(): void {
    this.clear()
  }

  private async loadForeignKeys(schema: string, table: string): Promise<ForeignKeyInfo[]> {
    const result = await this.executor.query(FOREIGN_KEYS_SQL, [schema, table])
    return result.rows.map((row) => ({
      constraint: String(row['constraint']),
      sourceSchema: String(row['source_schema']),
      sourceTable: String(row['source_table']),
      columns: (row['columns'] as string[] | null) ?? [],
      referencedSchema: String(row['referenced_schema']),
      referencedTable: String(row['referenced_table']),
      referencedColumns: (row['referenced_columns'] as string[] | null) ?? [],
    }))
  }

  private async loadTable(schema: string, table: string): Promise<TableInfo | undefined> {
    const [columnsResult, pkResult] = await Promise.all([
      this.executor.query(COLUMNS_SQL, [schema, table]),
      this.executor.query(PRIMARY_KEY_SQL, [schema, table]),
    ])
    if (columnsResult.rows.length === 0) return undefined
    const columns: ColumnInfo[] = columnsResult.rows.map((row) => ({
      name: String(row['name']),
      hasDefault: Boolean(row['has_default']),
      defaultExpr: row['default_expr'] === null ? null : String(row['default_expr']),
      generated: Boolean(row['generated']),
      identity: Boolean(row['identity']),
      nullable: Boolean(row['nullable']),
    }))
    const primaryKey = pkResult.rows.map((row) => String(row['name']))
    return { schema, name: table, columns, primaryKey }
  }

  private async loadFunctions(schema: string, name: string): Promise<FunctionInfo[]> {
    const result = await this.executor.query(FUNCTIONS_SQL, [schema, name])
    if (result.rows.length === 0) return []

    const oidSet = new Set<number>()
    const parsed: Array<
      Omit<FunctionInfo, 'args'> & { args: Array<{ name?: string; oid: number }>; nDefaults: number }
    > = []

    for (const row of result.rows) {
      const names = (row['arg_names'] as (string | null)[] | null) ?? []
      const modes = row['proargmodes'] as string[] | null
      const allTypes = row['all_arg_types'] as number[] | null
      const inTypes = (row['in_arg_types'] as number[] | null) ?? []
      const nDefaults = Number(row['n_defaults'] ?? 0)
      const args: Array<{ name?: string; oid: number }> = []
      if (modes && allTypes) {
        for (let i = 0; i < modes.length; i++) {
          const mode = modes[i]!
          if (mode === 'i' || mode === 'b' || mode === 'v') {
            args.push({ name: names[i] || undefined, oid: allTypes[i]! })
          }
        }
      } else {
        for (let i = 0; i < inTypes.length; i++) {
          args.push({ name: names[i] || undefined, oid: inTypes[i]! })
        }
      }
      for (const arg of args) oidSet.add(arg.oid)
      const returnTyptype = String(row['return_typtype'] ?? '')
      const hasOutputCols = modes ? modes.some((m) => m === 'o' || m === 't') : false
      parsed.push({
        schema,
        name,
        returnsSet: Boolean(row['returns_set']),
        returnsRows: returnTyptype === 'c' || hasOutputCols,
        volatility: volatilityOf(String(row['volatility'] ?? 'v')),
        args,
        nDefaults,
      })
    }

    const typeNames = new Map<number, string>()
    if (oidSet.size > 0) {
      const typeResult = await this.executor.query(TYPE_NAMES_SQL, [[...oidSet]])
      for (const row of typeResult.rows) {
        typeNames.set(Number(row['oid']), String(row['name']))
      }
    }
    return parsed.map((entry) => ({
      schema: entry.schema,
      name: entry.name,
      returnsSet: entry.returnsSet,
      returnsRows: entry.returnsRows,
      volatility: entry.volatility,
      args: entry.args.map((arg, index) => ({
        name: arg.name,
        type: typeNames.get(arg.oid) ?? `oid:${arg.oid}`,
        hasDefault: index >= entry.args.length - entry.nDefaults,
      })),
    }))
  }
}
