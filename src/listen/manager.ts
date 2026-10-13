import pg from 'pg'
import { PgFluentError } from '../errors/index.js'

/** Notification metadata passed to listeners. */
export interface ListenMeta {
  channel: string
  payload: string
  processId: number
}

/** The handle returned by `db.listen(...)`. */
export interface ListenSubscription {
  unlisten(): Promise<void>
}

/** Per-subscription options. */
export interface ListenOptions {
  /** Called after a reconnection re-registers this channel (for re-sync). */
  onReconnect?: () => void | Promise<void>
}

type ListenCallback = (payload: string, meta: ListenMeta) => void

interface Subscription {
  channel: string
  callback: ListenCallback
  onReconnect?: () => void | Promise<void>
}

const CHANNEL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Throw unless `channel` is a valid PostgreSQL identifier. */
export function assertChannel(channel: string): void {
  if (!CHANNEL_RE.test(channel)) {
    throw new PgFluentError(
      'PGFLUENT_INVALID_QUERY',
      `Invalid LISTEN/NOTIFY channel ${JSON.stringify(channel)}: must be a valid PostgreSQL identifier`
    )
  }
}

/**
 * A dedicated, non-pooled LISTEN connection (shared across channels) with
 * automatic reconnect (exponential backoff + jitter) and re-`LISTEN` on every
 * channel. Always uses the primary connection.
 */
export class ListenManager {
  private client: pg.Client | null = null
  private stopped = false
  private running = false
  private firstConnect = true
  private reconnectAttempt = 0
  private reconnectTimer?: NodeJS.Timeout
  private connecting: Promise<void> | null = null
  private readonly subscriptions = new Map<string, Set<Subscription>>()
  private readonly eventHandlers = new Map<string, Set<(...args: unknown[]) => void>>()

  constructor(private readonly config: pg.PoolConfig) {}

  /** Subscribe to `channel`. Establishes the connection (and LISTENs) first. */
  async subscribe(
    channel: string,
    callback: ListenCallback,
    options?: ListenOptions
  ): Promise<ListenSubscription> {
    assertChannel(channel)
    const sub: Subscription = { channel, callback, onReconnect: options?.onReconnect }
    let set = this.subscriptions.get(channel)
    if (!set) {
      set = new Set<Subscription>()
      this.subscriptions.set(channel, set)
    }
    set.add(sub)
    await this.ensureConnected()
    if (this.running && this.client) {
      await this.query('LISTEN ' + pg.escapeIdentifier(channel))
    }
    return {
      unlisten: () => this.unsubscribe(channel, callback),
    }
  }

  /** Remove a callback (or all callbacks) for `channel`. */
  async unsubscribe(channel: string, callback?: ListenCallback): Promise<void> {
    assertChannel(channel)
    const set = this.subscriptions.get(channel)
    if (!set) return
    if (callback === undefined) {
      set.clear()
    } else {
      for (const sub of set) {
        if (sub.callback === callback) set.delete(sub)
      }
    }
    if (set.size === 0) {
      this.subscriptions.delete(channel)
      await this.query('UNLISTEN ' + pg.escapeIdentifier(channel))
    }
  }

  /** Remove every listener. */
  async unlistenAll(): Promise<void> {
    this.subscriptions.clear()
    await this.query('UNLISTEN *')
  }

  /** Stop the connection and release all listeners. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.running = false
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.subscriptions.clear()
    const client = this.client
    this.client = null
    if (client) {
      try {
        await client.end()
      } catch {
        // Best-effort teardown.
      }
    }
  }

  on(event: ListenEvent, handler: (payload?: unknown) => void): void {
    let set = this.eventHandlers.get(event)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(event, set)
    }
    set.add(handler as (...args: unknown[]) => void)
  }

  off(event: ListenEvent, handler: (...args: unknown[]) => void): void {
    this.eventHandlers.get(event)?.delete(handler as (...args: unknown[]) => void)
  }

  private emit(event: ListenEvent, ...args: unknown[]): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      try {
        handler(...args)
      } catch {
        // A listener throwing must never crash the manager.
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.stopped) return
    if (this.running && this.client) return
    if (this.connecting) {
      await this.connecting
      return
    }
    this.connecting = this.connect().finally(() => {
      this.connecting = null
    })
    await this.connecting
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ ...this.config, application_name: 'pg-fluent-listen' })
    this.client = client
    client.on('notification', (msg) => {
      this.dispatch(msg.channel ?? '', msg.payload ?? '', msg.processId)
    })
    client.on('error', (err) => {
      this.emit('error', err)
      this.handleDisconnect(client)
    })
    client.on('end', () => {
      this.handleDisconnect(client)
    })
    try {
      await client.connect()
    } catch (err) {
      this.emit('error', err as Error)
      this.handleDisconnect(client)
      return
    }
    if (this.stopped) {
      await client.end()
      return
    }
    this.client = client
    this.reconnectAttempt = 0
    this.running = true
    this.emit('connected')
    const reconnected = this.firstConnect === false
    this.firstConnect = false
    for (const channel of this.subscriptions.keys()) {
      try {
        await client.query('LISTEN ' + pg.escapeIdentifier(channel))
      } catch (err) {
        this.emit('error', err as Error)
      }
    }
    if (reconnected) {
      for (const set of this.subscriptions.values()) {
        for (const sub of set) {
          if (sub.onReconnect) {
            try {
              await sub.onReconnect()
            } catch {
              // Best-effort re-sync hook.
            }
          }
        }
      }
    }
  }

  private handleDisconnect(client: pg.Client): void {
    if (this.stopped) return
    if (this.client !== client) return
    this.client = null
    this.running = false
    this.emit('disconnected')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.running || this.reconnectTimer !== undefined) return
    const attempt = ++this.reconnectAttempt
    const base = Math.min(1000 * 2 ** Math.min(attempt - 1, 6), 30000)
    const jitter = Math.floor(base * (0.75 + Math.random() * 0.5))
    this.emit('reconnecting', attempt, jitter)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.stopped) return
      void this.connect()
    }, jitter)
    this.reconnectTimer.unref?.()
  }

  private dispatch(channel: string, payload: string, processId: number): void {
    const set = this.subscriptions.get(channel)
    if (!set) return
    const meta: ListenMeta = { channel, payload, processId }
    for (const sub of set) {
      try {
        sub.callback(payload, meta)
      } catch {
        // Dispatch must not fail for other subscribers.
      }
    }
  }

  private async query(text: string): Promise<void> {
    if (!this.running || !this.client) return
    try {
      await this.client.query(text)
    } catch {
      // Connection may have dropped between the check and the query; the
      // reconnect path re-LISTENs from the subscription set.
    }
  }
}

export type ListenEvent = 'connected' | 'disconnected' | 'error' | 'reconnecting'