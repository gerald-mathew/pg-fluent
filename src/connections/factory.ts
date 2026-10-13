import pg from 'pg'
import { PgExecutor, type Executor } from '../exec/executor.js'
import type { ConnectionConfig, ReplicaConfig, RoutedConnectionConfig, SingleConnectionConfig } from './types.js'
import { isRouted } from './types.js'
import { RoutingExecutor } from './router.js'
import { DEFAULT_RETRIES, DEFAULT_STATEMENT_TIMEOUT_MS } from '../client.js'

export interface ConnectionBundle {
  executor: Executor
  pool: pg.Pool
  owned: boolean
  /** Name of this connection group. */
  name: string
  ownedPools?: pg.Pool[]
}

function buildSinglePool(config: SingleConnectionConfig, statementTimeoutDefault: number | null): { pool: pg.Pool; owned: boolean } {
  if (config.pool instanceof pg.Pool) {
    return { pool: config.pool, owned: false }
  }
  const poolConfig: pg.PoolConfig = {}
  if (config.connectionString !== undefined) poolConfig.connectionString = config.connectionString
  if (config.host !== undefined) poolConfig.host = config.host
  if (config.port !== undefined) poolConfig.port = config.port
  if (config.database !== undefined) poolConfig.database = config.database
  if (config.user !== undefined) poolConfig.user = config.user
  if (config.password !== undefined) poolConfig.password = config.password
  if (config.ssl !== undefined) poolConfig.ssl = config.ssl
  if (config.pool !== undefined && !(config.pool instanceof pg.Pool)) {
    Object.assign(poolConfig, config.pool)
  }

  const timeout = config.statementTimeoutMs === undefined ? statementTimeoutDefault : config.statementTimeoutMs
  if (timeout !== null) poolConfig.statement_timeout = timeout

  return { pool: new pg.Pool(poolConfig), owned: true }
}

export function buildConnectionBundle(
  name: string,
  config: ConnectionConfig,
  defaults: { statementTimeoutMs: number | null }
): ConnectionBundle {
  if (!isRouted(config)) {
    const { pool, owned } = buildSinglePool(config, defaults.statementTimeoutMs)
    const executor = new PgExecutor(pool)
    return { executor, pool, owned, name }
  }
  const routed = config as RoutedConnectionConfig
  const primary = buildSinglePool(routed.primary, defaults.statementTimeoutMs)
  const replicas: Executor[] = []
  const replicaPools: pg.Pool[] = []
  for (const rep of routed.replicas ?? []) {
    const { pool, owned } = buildSinglePool(rep, defaults.statementTimeoutMs)
    replicaPools.push(pool)
    replicas.push(new PgExecutor(pool))
  }
  const executor = new RoutingExecutor({ primary: new PgExecutor(primary.pool), replicas })
  const ownedPools: pg.Pool[] = []
  if (primary.owned) ownedPools.push(primary.pool)
  for (const rep of replicaPools) ownedPools.push(rep)
  return { executor, pool: primary.pool, owned: primary.owned, name, ownedPools }
}
