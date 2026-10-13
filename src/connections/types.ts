import type pg from 'pg'
import type { PoolOptions } from '../client.js'

export interface SingleConnectionConfig {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: pg.PoolConfig['ssl']
  pool?: pg.Pool | (pg.PoolConfig & PoolOptions)
  statementTimeoutMs?: number | null
  /** Enable read-replica routing for this connection. */
  replicas?: ReplicaConfig[]
}

export interface ReplicaConfig extends Omit<SingleConnectionConfig, 'replicas'> {}

export interface RoutedConnectionConfig {
  primary: SingleConnectionConfig
  replicas?: ReplicaConfig[]
}

export type ConnectionConfig = SingleConnectionConfig | RoutedConnectionConfig

export function isRouted(config: ConnectionConfig): config is RoutedConnectionConfig {
  return 'primary' in config && config.primary !== undefined
}
