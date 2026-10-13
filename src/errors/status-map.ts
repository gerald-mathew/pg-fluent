/**
 * PostgreSQL SQLSTATE -> HTTP status mapping, mirroring PostgREST.
 *
 * Source: https://docs.postgrest.org/en/stable/references/errors.html#http-status-codes
 * Verified 2026-10-12.
 */

const EXACT: Readonly<Record<string, number>> = {
  '23503': 409, // foreign key violation
  '23505': 409, // uniqueness violation
  '25006': 405, // read only sql transaction
  '53400': 500, // configuration limit exceeded
  '57014': 504, // query canceled (statement_timeout / cancel request)
  '42883': 404, // undefined function
  '42P01': 404, // undefined table
  '42P17': 500, // infinite recursion
  '42501': 403, // insufficient privileges
  P0001: 400, // default code for "raise"
}

const PREFIX: ReadonlyArray<readonly [string, number]> = [
  ['08', 503], // pg connection err
  ['09', 500], // triggered action exception
  ['0L', 403], // invalid grantor
  ['0P', 403], // invalid role specification
  ['25', 500], // invalid transaction state
  ['28', 403], // invalid auth specification
  ['2D', 500], // invalid transaction termination
  ['38', 500], // external routine exception
  ['39', 500], // external routine invocation
  ['3B', 500], // savepoint exception
  ['40', 500], // transaction rollback
  ['53', 503], // insufficient resources
  ['54', 500], // too complex
  ['55', 500], // obj not in prerequisite state
  ['57', 500], // operator intervention
  ['58', 500], // system error
  ['F0', 500], // config file error
  ['HV', 500], // foreign data wrapper error
  ['P0', 500], // PL/pgSQL error
  ['XX', 500], // internal error
]

/** PostgREST's own error codes -> HTTP status. */
const PGRST: Readonly<Record<string, number>> = {
  PGRST000: 503,
  PGRST001: 503,
  PGRST002: 503,
  PGRST003: 504,
  PGRST100: 400,
  PGRST101: 405,
  PGRST102: 400,
  PGRST103: 416,
  PGRST105: 405,
  PGRST106: 406,
  PGRST107: 406,
  PGRST108: 400,
  PGRST111: 500,
  PGRST112: 500,
  PGRST114: 400,
  PGRST115: 400,
  PGRST116: 406,
  PGRST117: 405,
  PGRST118: 400,
  PGRST120: 400,
  PGRST121: 500,
  PGRST122: 400,
  PGRST123: 400,
  PGRST124: 400,
  PGRST125: 404,
  PGRST126: 404,
  PGRST127: 400,
  PGRST128: 400,
  PGRST200: 400,
  PGRST201: 300,
  PGRST202: 404,
  PGRST203: 300,
  PGRST204: 400,
  PGRST205: 404,
  PGRST300: 500,
  PGRST301: 401,
  PGRST302: 401,
  PGRST303: 401,
  PGRSTX00: 500,
}

/** Library-specific error codes -> HTTP status. */
export const PGFLUENT_STATUS: Readonly<Record<string, number>> = {
  PGFLUENT_INVALID_QUERY: 400,
  PGFLUENT_UNFILTERED_MUTATION: 400,
  PGFLUENT_NOT_IMPLEMENTED: 400,
  PGFLUENT_ABORTED: 499,
  PGFLUENT_TIMEOUT: 504,
  PGFLUENT_CONNECTION: 503,
  PGFLUENT_POOL_EXHAUSTED: 504,
  PGFLUENT_CLOSED: 500,
  PGFLUENT_INTERNAL: 500,
}

/** Map a SQLSTATE returned by PostgreSQL to an HTTP status. */
export function statusFromSqlState(sqlstate: string | undefined): number {
  if (!sqlstate) return 500
  const code = sqlstate.toUpperCase()
  if (code in PGRST) return PGRST[code]!
  if (code in EXACT) return EXACT[code]!
  // Custom RAISE of the form PT402 -> 402
  const ptMatch = /^PT(\d{3})$/.exec(code)
  if (ptMatch) {
    const n = Number(ptMatch[1])
    if (n >= 100 && n <= 599) return n
  }
  for (const [prefix, status] of PREFIX) {
    if (code.startsWith(prefix)) return status
  }
  return 400
}
