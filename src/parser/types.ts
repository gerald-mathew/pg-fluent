/** A JSON access step on a column: `col->'a'` or `col->>'a'`. */
export interface JsonStep {
  op: '->' | '->>'
  key: string
}

/** A column reference, optionally with a JSON path. */
export interface ColumnPath {
  base: string
  steps: JsonStep[]
}

export interface StarItem {
  kind: 'star'
}

export interface ColumnItem {
  kind: 'column'
  alias?: string
  path: ColumnPath
  cast?: string
}

export interface AggregateItem {
  kind: 'aggregate'
  alias?: string
  fn: string
  /** `undefined` for `count()`; `{ star: true }` for `count(*)`; else a column. */
  arg?: ColumnPath | { star: true }
  cast?: string
}

export interface ResolvedRelationship {
  kind: 'to-one' | 'to-many'
  table: { schema: string; name: string }
  /** Columns on the embedding (parent) side. */
  baseColumns: string[]
  /** Matching columns on the related table. */
  relationColumns: string[]
  junction?: {
    schema: string
    name: string
    /** Columns on the parent matching `junctionBaseColumns`. */
    baseColumns: string[]
    junctionBaseColumns: string[]
    /** Columns on the related table matching `junctionRelationColumns`. */
    relationColumns: string[]
    junctionRelationColumns: string[]
  }
}

export interface EmbedItem {
  kind: 'embed'
  alias: string
  relation: string
  /** Disambiguation hint: fk constraint name, junction table or column. */
  hint?: string
  /** `!inner` join. */
  inner: boolean
  /** `...rel(...)` spread. */
  spread: boolean
  columns: SelectItem[]
  /** Filled in by the relationship resolver before planning. */
  relationship?: ResolvedRelationship
}

export type SelectItem = StarItem | ColumnItem | AggregateItem | EmbedItem

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'match'
  | 'imatch'
  | 'is'
  | 'isdistinct'
  | 'in'
  | 'cs'
  | 'cd'
  | 'ov'
  | 'sl'
  | 'sr'
  | 'nxl'
  | 'nxr'
  | 'adj'
  | 'fts'
  | 'plfts'
  | 'phfts'
  | 'wfts'

export interface FilterCondition {
  kind: 'condition'
  /** The column or embedded relation the filter targets. */
  column: ColumnPath
  /** For embedded filters, the dotted path before the column, e.g. `posts`. */
  relation?: string[]
  negated: boolean
  operator: FilterOperator
  modifier?: 'any' | 'all'
  /** Full-text search config, e.g. `english`. */
  config?: string
  /** Raw value string exactly as emitted by upstream (already unescaped). */
  value: string
}

export interface LogicalFilter {
  kind: 'and' | 'or'
  nodes: FilterNode[]
  relation?: string[]
}

export type FilterNode = FilterCondition | LogicalFilter

/** A query-string parameter targeting an embedded resource. */
export interface EmbeddedParam {
  /** Relation path from the base table, e.g. `['posts']` or `['posts','comments']`. */
  path: string[]
  kind: 'filter' | 'order' | 'limit' | 'offset' | 'or' | 'and'
  /** The filter/logical key (relative to the embed); empty for `order`/`limit`/`offset`. */
  key: string
  value: string
}

export interface OrderTerm {
  relation?: string[]
  column: ColumnPath
  ascending: boolean
  nullsFirst?: boolean
}

export interface ParsedRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE'
  schema: string
  resource:
    | { kind: 'table'; name: string }
    | { kind: 'rpc'; name: string }
  select: SelectItem[]
  filters: FilterNode[]
  /** Raw query-string pairs, retained for RPC calls (args + filters mixed). */
  query?: Array<[string, string]>
  /** Query-string parameters that target embedded resources. */
  embedded: EmbeddedParam[]
  order: OrderTerm[]
  limit?: number
  offset?: number
  onConflict?: string[]
  columns?: string[]
  count?: 'exact' | 'planned' | 'estimated'
  returnRepresentation: boolean
  resolution?: 'merge' | 'ignore'
  missingDefault?: boolean
  single: boolean
  mediaType: 'json' | 'object' | 'csv' | 'geojson' | 'plan'
  planFormat?: 'json' | 'text'
  planOptions?: string
  stripNulls: boolean
  rollback: boolean
  maxAffected?: number
  /** `.allowUnfiltered()` — permit this mutation without a filter. */
  allowUnfiltered: boolean
  /** `.timeout(ms)` — per-request `statement_timeout`. */
  timeoutMs?: number
  forcePrimary: boolean
  stream: boolean
  body?: unknown
  signal?: AbortSignal
  /**
   * Resolved to-one relationships for related-table ordering
   * (`order=rel.col.asc`), keyed by dotted relation path. Filled in by the
   * adapter before planning.
   */
  orderRelationships?: Map<string, ResolvedRelationship[]>
  /**
   * Resolved relationships for top-level `or`/`and` filters that reference
   * embedded relations, keyed by the first relation segment.
   */
  filterRelationships?: Map<string, ResolvedRelationship>
}
