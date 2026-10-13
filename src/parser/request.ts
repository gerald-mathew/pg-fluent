import { pgrstError } from '../errors/index.js'
import { ALLOW_UNFILTERED_HEADER, PRIMARY_HEADER, STREAM_HEADER, TIMEOUT_HEADER } from '../extensions/constants.js'
import { parseFilters } from './filter.js'
import { parseOrder } from './order.js'
import { parseSelect } from './select.js'
import type { EmbeddedParam, FilterNode, ParsedRequest, SelectItem } from './types.js'

export interface RawRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface RequestParseContext {
  /** Schemas the client is allowed to expose; first is the default. */
  schemas: string[]
  defaultSchema: string
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'])

interface PreferFlags {
  count?: 'exact' | 'planned' | 'estimated'
  returnRepresentation: boolean
  rollback: boolean
  maxAffected?: number
  resolution?: 'merge' | 'ignore'
  missingDefault: boolean
}

function parsePrefer(header: string | undefined): PreferFlags {
  const flags: PreferFlags = {
    returnRepresentation: false,
    rollback: false,
    missingDefault: false,
  }
  if (!header) return flags
  for (const part of header.split(',')) {
    const token = part.trim()
    if (token === 'return=representation') flags.returnRepresentation = true
    else if (token === 'return=minimal') flags.returnRepresentation = false
    else if (token === 'tx=rollback') flags.rollback = true
    else if (token === 'missing=default') flags.missingDefault = true
    else if (token.startsWith('count=')) {
      const v = token.slice('count='.length)
      if (v === 'exact' || v === 'planned' || v === 'estimated') flags.count = v
    } else if (token.startsWith('max-affected=')) {
      const n = Number(token.slice('max-affected='.length))
      if (Number.isInteger(n) && n >= 0) flags.maxAffected = n
    } else if (token === 'resolution=merge-duplicates') flags.resolution = 'merge'
    else if (token === 'resolution=ignore-duplicates') flags.resolution = 'ignore'
  }
  return flags
}

interface AcceptInfo {
  mediaType: ParsedRequest['mediaType']
  single: boolean
  stripNulls: boolean
  planFormat?: 'json' | 'text'
  planOptions?: string
}

function parseAccept(header: string | undefined): AcceptInfo {
  const info: AcceptInfo = { mediaType: 'json', single: false, stripNulls: false }
  if (!header) return info
  info.stripNulls = header.includes('nulls=stripped')
  if (header.includes('text/csv')) info.mediaType = 'csv'
  else if (header.includes('application/geo+json')) info.mediaType = 'geojson'
  else if (header.includes('application/vnd.pgrst.plan+')) {
    info.mediaType = 'plan'
    info.planFormat = header.includes('plan+text') ? 'text' : 'json'
    const opts = /options=([^;]*)/.exec(header)
    if (opts) info.planOptions = opts[1]!.trim()
  } else if (header.includes('application/vnd.pgrst.object+json')) {
    info.single = true
  }
  return info
}

function parseNumber(value: string | null, name: string): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw pgrstError('PGRST100', `Invalid ${name}: ${value}`)
  }
  return n
}

function parseColumns(value: string | null): string[] | undefined {
  if (value === null) return undefined
  const out: string[] = []
  for (const raw of value.split(',')) {
    let col = raw.trim()
    if (col.startsWith('"') && col.endsWith('"')) col = col.slice(1, -1).replace(/""/g, '"')
    if (col !== '') out.push(col)
  }
  return out.length ? out : undefined
}

const EMBED_MODIFIERS = new Set(['order', 'limit', 'offset', 'or', 'and'])

/** Split an embedded query-string key such as `posts.comments.limit`. */
function classifyEmbeddedParam(key: string, value: string): EmbeddedParam {
  const dot = key.lastIndexOf('.')
  const prefix = key.slice(0, dot)
  const last = key.slice(dot + 1)
  const path = prefix.split('.')
  if (EMBED_MODIFIERS.has(last)) {
    return { path, kind: last as EmbeddedParam['kind'], key: last, value }
  }
  return { path, kind: 'filter', key: last, value }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw pgrstError('PGRST100', `Invalid URL path segment: ${segment}`)
  }
}

/** Translate an intercepted HTTP request into a `ParsedRequest`. */
export function parseRequest(raw: RawRequest, ctx: RequestParseContext): ParsedRequest {
  if (!METHODS.has(raw.method)) {
    throw pgrstError('PGRST117', `Invalid HTTP method: ${raw.method}`)
  }
  const method = raw.method as ParsedRequest['method']
  const url = new URL(raw.url)
  const path = url.pathname.replace(/^\/+/, '')

  const isRead = method === 'GET' || method === 'HEAD'
  const profileHeader = isRead ? raw.headers['accept-profile'] : raw.headers['content-profile']
  const schema = profileHeader ?? ctx.defaultSchema
  if (!ctx.schemas.includes(schema)) {
    throw pgrstError(
      'PGRST106',
      `The schema must be one of the following: ${ctx.schemas.join(', ')}`,
      { details: `Requested schema: ${schema}` }
    )
  }

  let resource: ParsedRequest['resource']
  let rpcName: string | undefined
  if (path.startsWith('rpc/')) {
    rpcName = decodeSegment(path.slice('rpc/'.length))
    resource = { kind: 'rpc', name: rpcName }
  } else {
    resource = { kind: 'table', name: decodeSegment(path) }
  }

  const params = url.searchParams
  let filters: FilterNode[] = []
  let query: Array<[string, string]> | undefined
  let embedded: EmbeddedParam[] = []
  if (resource.kind === 'rpc') {
    query = [...params].map(([key, value]) => [key, value])
  } else {
    const parsed = parseFilters(params)
    filters = parsed.filters
    embedded = parsed.embedded.map((e) => classifyEmbeddedParam(e.key, e.value))
  }

  const select: SelectItem[] = parseSelect(params.get('select') ?? undefined)
  const order = parseOrder(params.get('order') ?? '')
  const limit = parseNumber(params.get('limit'), 'limit')
  const offset = parseNumber(params.get('offset'), 'offset')
  const onConflict = params.get('on_conflict')
  const columns = parseColumns(params.get('columns'))
  const prefer = parsePrefer(raw.headers['prefer'])
  const accept = parseAccept(raw.headers['accept'])

  const allowUnfiltered = raw.headers[ALLOW_UNFILTERED_HEADER] === '1'
  const timeoutRaw = raw.headers[TIMEOUT_HEADER]
  let timeoutMs: number | undefined
  if (timeoutRaw !== undefined && timeoutRaw !== '') {
    const n = Number(timeoutRaw)
    if (!Number.isInteger(n) || n <= 0) {
      throw pgrstError('PGRST100', `Invalid timeout: ${timeoutRaw}`)
    }
    timeoutMs = n
  }

  let body: unknown
  if (raw.body !== undefined && raw.body !== '') {
    try {
      body = JSON.parse(raw.body)
    } catch {
      throw pgrstError('PGRST102', 'Invalid request body: malformed JSON')
    }
  }

  return {
    method,
    schema,
    resource,
    select,
    filters,
    query,
    embedded,
    order,
    limit,
    offset,
    onConflict: onConflict ? onConflict.split(',').map((s) => s.trim()) : undefined,
    columns,
    count: prefer.count,
    returnRepresentation: prefer.returnRepresentation,
    resolution: prefer.resolution,
    missingDefault: prefer.missingDefault,
    single: accept.single,
    mediaType: accept.mediaType,
    planFormat: accept.planFormat,
    planOptions: accept.planOptions,
    stripNulls: accept.stripNulls,
    rollback: prefer.rollback,
    maxAffected: prefer.maxAffected,
    allowUnfiltered,
    timeoutMs,
    forcePrimary: raw.headers[PRIMARY_HEADER] === '1',
    stream: raw.headers[STREAM_HEADER] === '1',
    body,
    signal: raw.signal,
  }
}
