import { PgFluentError } from '../errors/index.js'

const MAX_IDENT_BYTES = 63

/**
 * Quote a PostgreSQL identifier so it can be embedded safely in SQL text.
 *
 * This is the ONLY function permitted to place a caller-supplied name into SQL
 * text. It rejects empty names, NUL bytes and names longer than PostgreSQL's
 * 63-byte identifier limit, then double-quotes the name and escapes embedded
 * double quotes (`"` -> `""`).
 */
export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new PgFluentError('PGFLUENT_INVALID_QUERY', 'Invalid identifier: empty name')
  }
  if (name.includes('\u0000')) {
    throw new PgFluentError('PGFLUENT_INVALID_QUERY', 'Invalid identifier: contains NUL byte')
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_IDENT_BYTES) {
    throw new PgFluentError(
      'PGFLUENT_INVALID_QUERY',
      `Invalid identifier: exceeds ${MAX_IDENT_BYTES} bytes`
    )
  }
  return `"${name.replace(/"/g, '""')}"`
}

/** Quote a schema-qualified relation name, e.g. `"public"."users"`. */
export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

const CAST_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?(?:\[\])*$/

/**
 * Validate a cast/type name and return its qualified, quoted form.
 * Accepts `type`, `schema.type` and any number of trailing `[]`.
 * Only a strict grammar is allowed; nothing from this function is passed
 * through unvalidated.
 */
export function quoteCast(type: string): string {
  if (!CAST_RE.test(type)) {
    throw new PgFluentError('PGFLUENT_INVALID_QUERY', `Invalid cast type: ${sanitize(type)}`)
  }
  const arrayMatch = /(\[\])*$/.exec(type)
  const dims = arrayMatch ? arrayMatch[0] : ''
  const base = dims ? type.slice(0, -dims.length) : type
  const parts = base.split('.')
  const rendered = parts.map((p) => quoteIdent(p)).join('.')
  return rendered + dims
}

/**
 * Quote a string as a SQL literal. Used only for values that PostgreSQL cannot
 * receive as bind parameters (e.g. `IS NULL` / boolean keywords). Never used
 * for general filter values, which are always bound.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Ensure a string is safe to place inside an error message. */
export function sanitize(value: string): string {
  return String(value).replace(/[\u0000-\u001f]/g, '?').slice(0, 200)
}
