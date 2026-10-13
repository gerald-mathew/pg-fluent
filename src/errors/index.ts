import { statusFromSqlState, PGFLUENT_STATUS } from './status-map.js'
import { redactSecrets } from './redact.js'

export type PgFluentErrorCode =
  | 'PGFLUENT_INVALID_QUERY'
  | 'PGFLUENT_UNFILTERED_MUTATION'
  | 'PGFLUENT_NOT_IMPLEMENTED'
  | 'PGFLUENT_ABORTED'
  | 'PGFLUENT_TIMEOUT'
  | 'PGFLUENT_CONNECTION'
  | 'PGFLUENT_POOL_EXHAUSTED'
  | 'PGFLUENT_CLOSED'
  | 'PGFLUENT_INTERNAL'

/**
 * Classification of an error, independent of the wire format. Mirrors the
 * taxonomy in the specification (§9.2).
 */
export type ErrorKind =
  | 'validation'
  | 'parse'
  | 'database'
  | 'connection'
  | 'timeout'
  | 'aborted'
  | 'internal'

const KIND_BY_CODE: Readonly<Record<string, ErrorKind>> = {
  PGFLUENT_INVALID_QUERY: 'validation',
  PGFLUENT_UNFILTERED_MUTATION: 'validation',
  PGFLUENT_NOT_IMPLEMENTED: 'validation',
  PGFLUENT_ABORTED: 'aborted',
  PGFLUENT_TIMEOUT: 'timeout',
  PGFLUENT_CONNECTION: 'connection',
  PGFLUENT_POOL_EXHAUSTED: 'connection',
  PGFLUENT_CLOSED: 'internal',
  PGFLUENT_INTERNAL: 'internal',
}

/**
 * Error thrown or returned by pg-fluent for client-side / execution failures.
 * Database errors from PostgreSQL are represented separately (see
 * `databaseError`).
 */
export class PgFluentError extends Error {
  readonly code: PgFluentErrorCode
  readonly kind: ErrorKind
  readonly status: number
  readonly details: string
  readonly hint: string

  constructor(
    code: PgFluentErrorCode,
    message: string,
    options: { details?: string; hint?: string; cause?: unknown } = {}
  ) {
    super(message)
    this.name = 'PgFluentError'
    this.code = code
    this.kind = KIND_BY_CODE[code] ?? 'internal'
    this.status = PGFLUENT_STATUS[code] ?? 500
    this.details = options.details ?? ''
    this.hint = options.hint ?? ''
    if (options.cause !== undefined) this.cause = options.cause
  }

  toJSON(): { message: string; details: string; hint: string; code: string } {
    return { message: this.message, details: this.details, hint: this.hint, code: this.code }
  }
}

/** The `{ data, error }` error shape, identical to upstream PostgrestError. */
export interface PostgrestErrorShape {
  message: string
  details: string
  hint: string
  code: string
}

export interface ClassifiedError extends PostgrestErrorShape {
  kind: ErrorKind
  status: number
}

/** A thrown/returned error carrying a PostgREST-style `PGRSTxxx` code. */
export class PostgrestRequestError extends Error implements ClassifiedError {
  readonly code: string
  readonly kind: ErrorKind
  readonly status: number
  readonly details: string
  readonly hint: string

  constructor(code: string, message: string, parts: { details?: string | null; hint?: string | null } = {}) {
    super(message)
    this.name = 'PostgrestRequestError'
    this.code = code
    this.kind = code === 'PGRST100' ? 'parse' : 'validation'
    this.status = statusFromSqlState(code)
    this.details = parts.details ?? ''
    this.hint = parts.hint ?? ''
  }

  toJSON(): PostgrestErrorShape {
    return { message: this.message, details: this.details, hint: this.hint, code: this.code }
  }
}

/** Build a classified error with a PostgREST (PGRSTxxx) code. */
export function pgrstError(
  code: string,
  message: string,
  parts: { details?: string | null; hint?: string | null } = {}
): PostgrestRequestError {
  return new PostgrestRequestError(code, message, parts)
}

/** Shape of the errors returned by the `pg` driver. */
export interface PgDatabaseError {
  message?: string
  code?: string
  detail?: string | null
  hint?: string | null
  position?: string
  internalQuery?: string
  severity?: string
}

/**
 * Convert a PostgreSQL error into the PostgREST error shape. The `code` is the
 * SQLSTATE, `details`/`hint` map to PostgreSQL's detail/hint, and the HTTP
 * status comes from the status map in `status-map.ts`.
 */
export function databaseError(err: PgDatabaseError): ClassifiedError {
  return {
    message: redactSecrets(err.message ?? ''),
    details: redactSecrets(err.detail ?? ''),
    hint: redactSecrets(err.hint ?? ''),
    code: err.code ?? '',
    kind: err.code === '57014' ? 'timeout' : 'database',
    status: statusFromSqlState(err.code),
  }
}

export function fromPgFluentError(err: PgFluentError): ClassifiedError {
  return {
    message: redactSecrets(err.message),
    details: redactSecrets(err.details),
    hint: redactSecrets(err.hint),
    code: err.code,
    kind: err.kind,
    status: err.status,
  }
}

export { statusFromSqlState } from './status-map.js'
export { redactSecrets, redactConnectionString } from './redact.js'
