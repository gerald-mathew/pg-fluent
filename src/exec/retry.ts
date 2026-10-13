export interface RetryConfig {
  max: number
  backoffMs: number
}

/** SQLSTATEs for transient server-side shutdowns. */
const TRANSIENT_SQLSTATES = new Set(['57P01', '57P02', '57P03'])

const TRANSIENT_MESSAGE =
  /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|Connection terminated|connection terminated|server closed the connection|timeout exceeded when trying to connect|Client has encountered a connection error/i

/**
 * True when an error is likely transient and worth retrying for an idempotent
 * statement: connection-level failures and server shutdown/restart.
 */
export function isTransientError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (code === 'PGFLUENT_CONNECTION') return true
  if (typeof code === 'string') {
    if (code.startsWith('08')) return true
    if (TRANSIENT_SQLSTATES.has(code)) return true
  }
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && TRANSIENT_MESSAGE.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export interface RetryResult<T> {
  value: T
  attempts: number
}

/**
 * Run `fn` up to `retries.max` extra times when it rejects with a transient
 * error, applying exponential backoff with jitter.
 */
export async function withRetry<T>(
  retries: RetryConfig | undefined,
  fn: (attempt: number) => Promise<T>,
  isRetryable: (err: unknown) => boolean = isTransientError
): Promise<RetryResult<T>> {
  const max = retries?.max ?? 0
  const backoff = retries?.backoffMs ?? 0
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      return { value: await fn(attempt), attempts: attempt }
    } catch (err) {
      if (attempt > max || !isRetryable(err)) throw err
      const base = backoff > 0 ? backoff * 2 ** (attempt - 1) : 0
      const jitter = base > 0 ? Math.floor((Math.random() * base) / 2) : 0
      if (base + jitter > 0) await sleep(base + jitter)
    }
  }
}
