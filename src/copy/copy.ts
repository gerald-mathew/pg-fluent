import pg from 'pg'
import { PgFluentError } from '../errors/index.js'
import { quoteIdent } from '../sql/quote.js'

export interface CopyFromOptions {
  /** Column names, in order, for the COPY target. Inferred from rows when omitted. */
  columns?: string[]
  /** COPY format: `csv` (default) or `text`. */
  format?: 'csv' | 'text'
  /** Field delimiter for `csv` (default `,`) or `text` (default tab) format. */
  delimiter?: string
}

export interface CopyFromResult {
  data: { rowCount: number } | null
  error: unknown | null
}

/** pg-copy-streams is an optional peer; typed here as an ambient-like module. */
interface CopyStream {
  rowCount: number
  readonly writableEnded: boolean
  write(chunk: string | Buffer): boolean
  end(chunk?: string | Buffer): void
  once(event: 'finish' | 'drain', listener: () => void): this
  once(event: 'error', listener: (err: Error) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

function escapeCsvField(value: string): string {
  if (/["\n\r,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function escapeTextField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function encodeRows(
  rows: readonly Record<string, unknown>[],
  columns: string[],
  format: 'csv' | 'text',
  delimiter: string
): string[] {
  const esc = format === 'csv' ? escapeCsvField : escapeTextField
  return rows.map((row) => {
    const fields = columns.map((col) => {
      const value = renderValue((row as Record<string, unknown>)[col])
      return value === '' && format === 'csv' && (row as Record<string, unknown>)[col] === '' ? '""' : esc(value)
    })
    return fields.join(delimiter)
  })
}

async function loadCopyModule(): Promise<{ copyFrom: (sql: string) => CopyStream }> {
  try {
    const mod = (await import('pg-copy-streams')) as unknown as {
      copyFrom?: (sql: string) => CopyStream
      from?: (sql: string) => CopyStream
    }
    const fn = mod.copyFrom ?? mod.from
    if (typeof fn !== 'function') {
      throw new Error('pg-copy-streams did not export copyFrom/from')
    }
    return { copyFrom: fn }
  } catch {
    throw new PgFluentError(
      'PGFLUENT_NOT_IMPLEMENTED',
      'db.copyFrom() requires the optional peer dependency "pg-copy-streams" (npm install pg-copy-streams)'
    )
  }
}

/**
 * Bulk-load rows via COPY FROM STDIN. Column names are quoted; all values are
 * escaped by this library. `pg-copy-streams` is an optional peer dependency.
 */
export async function runCopy(
  pool: pg.Pool,
  table: string,
  rowsOrStream: AsyncIterable<Record<string, unknown>> | readonly Record<string, unknown>[],
  options: CopyFromOptions = {}
): Promise<CopyFromResult> {
  try {
    const mod = await loadCopyModule()
    const format = options.format ?? 'csv'
    const delimiter =
      options.delimiter ?? (format === 'csv' ? ',' : '\t')
    const columns =
      options.columns ??
      (Array.isArray(rowsOrStream) && rowsOrStream.length > 0
        ? Object.keys(rowsOrStream[0]!)
        : undefined)
    if (!columns || columns.length === 0) {
      throw new PgFluentError(
        'PGFLUENT_INVALID_QUERY',
        'db.copyFrom() needs a non-empty `columns` option or at least one row with keys to infer columns'
      )
    }

    const client = await pool.connect()
    try {
      const hasSchema = table.includes('.')
      const target = hasSchema
        ? table.split('.').map((p) => quoteIdent(p)).join('.')
        : quoteIdent(table)
      const header = `(${columns.map((c) => quoteIdent(c)).join(', ')})`
      const copySql = `COPY ${target} ${header} FROM STDIN WITH (FORMAT ${format.toUpperCase()}, DELIMITER ${JSON.stringify(delimiter)})`
      const copyStream = mod.copyFrom(copySql)
      client.query(copyStream as unknown as Parameters<pg.Client['query']>[0])

      if (Array.isArray(rowsOrStream)) {
        const lines = encodeRows(rowsOrStream, columns, format, delimiter)
        for (const line of lines) {
          if (!copyStream.write(`${line}\n`)) await drain(copyStream)
        }
      } else {
        for await (const row of rowsOrStream) {
          const line = encodeRows([row], columns, format, delimiter)[0]!
          if (!copyStream.write(`${line}\n`)) await drain(copyStream)
        }
      }
      copyStream.end()
      await new Promise<void>((resolve, reject) => {
        copyStream.once('finish', () => resolve())
        copyStream.once('error', (err: Error) => reject(err))
      })
      return { data: { rowCount: copyStream.rowCount }, error: null }
    } finally {
      client.release()
    }
  } catch (err) {
    return { data: null, error: err as Error }
  }
}

function drain(stream: CopyStream): Promise<void> {
  return new Promise((resolve) => {
    stream.once('drain', () => resolve())
  })
}