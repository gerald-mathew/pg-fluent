import {
  type Executor,
  type QueryResult,
  type RouteContext,
  type TransactionOptions,
} from '../exec/executor.js'
import { PgFluentError } from '../errors/index.js'

export type { RouteContext } from '../exec/executor.js'

export type Route = 'primary' | 'replica'

export interface RoutingExecutorOptions {
  primary: Executor
  replicas?: Executor[]
  /** Cooldown in ms before trying an unhealthy replica again (default 5000). */
  replicaCooldownMs?: number
}

const DEFAULT_COOLDOWN_MS = 5000

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') {
    // Common connection/endpoint errors
    if (code.startsWith('08') || code.startsWith('57P')) return true
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return true
    if (code === 'EHOSTUNREACH' || code === 'ENOTFOUND') return true
  }
  const msg = String((err as { message?: unknown } | null)?.message ?? '').toLowerCase()
  if (msg.includes('connection') && (msg.includes('reset') || msg.includes('refused') || msg.includes('closed'))) return true
  return false
}

export class RoutingExecutor implements Executor {
  private readonly primary: Executor
  private readonly replicas: Executor[]
  private readonly cooldownMs: number
  private nextReplica = 0
  private readonly unhealthy = new Map<number, number>() // index -> timestamp

  constructor(options: RoutingExecutorOptions) {
    this.primary = options.primary
    this.replicas = options.replicas ?? []
    this.cooldownMs = options.replicaCooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  private pickReplica(now: number): Executor | undefined {
    if (this.replicas.length === 0) return undefined
    const start = this.nextReplica
    for (let i = 0; i < this.replicas.length; i++) {
      const idx = (start + i) % this.replicas.length
      const until = this.unhealthy.get(idx)
      if (until === undefined || now >= until) {
        this.nextReplica = (idx + 1) % this.replicas.length
        return this.replicas[idx]
      }
    }
    // all unhealthy, fall through to primary
    return undefined
  }

  private markUnhealthy(executor: Executor): void {
    const idx = this.replicas.indexOf(executor)
    if (idx >= 0) {
      this.unhealthy.set(idx, Date.now() + this.cooldownMs)
    }
  }

  private choose(ctx?: RouteContext): Executor {
    if (!ctx) return this.primary
    if (ctx.forcePrimary || ctx.inTransaction || ctx.isWrite || ctx.isSchemaLoad || ctx.isVolatileRpc || ctx.isListenNotify) {
      return this.primary
    }
    const replica = this.pickReplica(Date.now())
    if (replica !== undefined) return replica
    return this.primary
  }

  async query(text: string, values?: unknown[], ctx?: RouteContext): Promise<QueryResult> {
    const exec = this.choose(ctx)
    try {
      return await exec.query(text, values)
    } catch (err) {
      // Only fallback on connection errors (never on query errors)
      if (this.replicas.length > 0 && exec !== this.primary && isConnectionError(err)) {
        this.markUnhealthy(exec)
        return this.primary.query(text, values)
      }
      throw err
    }
  }

  async queryWithSignal(
    text: string,
    values: unknown[] | undefined,
    signal: AbortSignal,
    ctx?: RouteContext
  ): Promise<QueryResult> {
    const exec = this.choose(ctx)
    try {
      if (exec.queryWithSignal) return exec.queryWithSignal(text, values, signal)
      return exec.query(text, values)
    } catch (err) {
      if (this.replicas.length > 0 && exec !== this.primary && isConnectionError(err)) {
        this.markUnhealthy(exec)
        if (this.primary.queryWithSignal) return this.primary.queryWithSignal(text, values, signal)
        return this.primary.query(text, values)
      }
      throw err
    }
  }

  transaction<T>(fn: (tx: Executor) => Promise<T>, options?: TransactionOptions): Promise<T> {
    // Always route transactions to primary
    return this.primary.transaction(fn, options)
  }

  async *stream(
    text: string,
    values?: unknown[],
    ctx?: RouteContext
  ): AsyncGenerator<Record<string, unknown>> {
    const exec = this.choose(ctx)
    if (!exec.stream) {
      throw new PgFluentError(
        'PGFLUENT_NOT_IMPLEMENTED',
        'Streaming is not supported by the selected executor'
      )
    }
    yield* exec.stream(text, values)
  }

  /** Expose underlying executors (used for building named connections). */
  getPrimary(): Executor {
    return this.primary
  }

  getReplicas(): Executor[] {
    return this.replicas.slice()
  }
}
