/**
 * Sentinel header used by extension methods to ask the fetch adapter for a
 * rendered plan instead of executing the query. The adapter strips it; it never
 * reaches the database.
 */
export const PLAN_HEADER = 'x-pgfluent-plan'

/** Value of {@link PLAN_HEADER} requesting `{ text, values }`. */
export const PLAN_SQL = 'sql'

/** Sentinel header set by `.allowUnfiltered()` to permit an unfiltered mutation. */
export const ALLOW_UNFILTERED_HEADER = 'x-pgfluent-allow-unfiltered'

/** Sentinel header set by `.timeout(ms)` carrying the per-request statement timeout. */
export const TIMEOUT_HEADER = 'x-pgfluent-timeout-ms'

/** Sentinel header set by `.primary()` to force routing to the primary. */
export const PRIMARY_HEADER = 'x-pgfluent-primary'

/** Sentinel header set by `.stream()` to request a cursor-based stream. */
export const STREAM_HEADER = 'x-pgfluent-stream'
