export { createClient } from './client.js'
export { Instrument } from './observability/index.js'
export type {
  Logger,
  ObservabilityOptions,
  QueryEvent,
  QueryOperation,
} from './observability/index.js'
export { withRetry, isTransientError } from './exec/retry.js'
export { installExtensions } from './extensions/to-sql.js'
export type { SqlPlan } from './extensions/to-sql.js'
export type { TransactionOptions } from './exec/executor.js'
export { SqlQuery } from './raw/index.js'
export type {
  IdentifierFragment,
  RawResult,
  SqlFragment,
  SqlInterpolation,
  SqlTag,
} from './raw/index.js'
export type {
  ConnectionConfig,
  PgFluentClient,
  PgFluentConfig,
  PgFluentExtras,
  PoolOptions,
  ReplicaConfig,
  RetryConfig,
  RoutedConnectionConfig,
  SingleConnectionConfig,
} from './client.js'
export {
  PgFluentError,
  PostgrestRequestError,
  pgrstError,
  databaseError,
  fromPgFluentError,
  statusFromSqlState,
} from './errors/index.js'
export type {
  ClassifiedError,
  ErrorKind,
  PgDatabaseError,
  PgFluentErrorCode,
  PostgrestErrorShape,
} from './errors/index.js'
export { parseRequest } from './parser/request.js'
export type { RawRequest, RequestParseContext } from './parser/request.js'
export { planRead } from './planner/read.js'
export type { ReadPlan, ReadOptions } from './planner/read.js'
export { planWrite } from './planner/write.js'
export { planRpc } from './planner/rpc.js'
export type { RpcOptions } from './planner/rpc.js'
export { SchemaCache } from './schema/cache.js'
export type {
  ColumnInfo,
  FunctionArgInfo,
  FunctionInfo,
  TableInfo,
} from './schema/cache.js'
export type { ParsedRequest, SelectItem, FilterNode, OrderTerm } from './parser/types.js'
