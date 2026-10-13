import type { ParsedRequest } from '../parser/types.js'
import type { ReadPlan } from '../planner/read.js'
import type { QueryResult } from '../exec/executor.js'
import { toCsv } from './csv.js'
import { toGeoJson } from './geojson.js'

export interface ReadResponseInput {
  plan: ReadPlan
  req: ParsedRequest
  result: QueryResult
  columns?: string[]
  countOverride?: number
}

function contentType(mediaType: ParsedRequest['mediaType']): string {
  switch (mediaType) {
    case 'csv':
      return 'text/csv; charset=utf-8'
    case 'geojson':
      return 'application/geo+json; charset=utf-8'
    case 'plan':
      return 'application/vnd.pgrst.plan+json; charset=utf-8'
    default:
      return 'application/json; charset=utf-8'
  }
}

function contentRange(offset: number, returned: number, count: number | undefined): string {
  if (returned === 0) return `*/${count ?? 0}`
  const end = offset + returned - 1
  return `${offset}-${end}/${count ?? '*'}`
}

function pgrst116(returned: number, count: number | undefined): Response {
  const body = JSON.stringify({
    code: 'PGRST116',
    details: `The result contains ${count ?? returned} rows`,
    hint: null,
    message: 'JSON object requested, multiple (or no) rows returned',
  })
  return new Response(body, {
    status: 406,
    statusText: 'Not Acceptable',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function buildReadResponse(input: ReadResponseInput): Response {
  const { plan, req, result } = input
  const row = result.rows[0] ?? {}
  const returned = Number(row['__pgfl_returned'] ?? 0)
  const rawCount = row['__pgfl_count']
  const count =
    input.countOverride ??
    (rawCount !== undefined && rawCount !== null ? Number(rawCount) : undefined)
  const bodyText = row['__pgfl_body']

  if (req.single && returned !== 1) {
    return pgrst116(returned, count)
  }

  let body: string | null = typeof bodyText === 'string' ? bodyText : null
  const headers: Record<string, string> = {
    'Content-Type': contentType(req.mediaType),
    'Content-Range': contentRange(plan.effectiveOffset, returned, count),
  }

  if (req.mediaType === 'csv') {
    const rowsArray = body === null ? [] : (JSON.parse(body) as Record<string, unknown>[])
    body = toCsv(rowsArray, input.columns)
  } else if (req.mediaType === 'geojson') {
    const rowsArray = body === null ? [] : (JSON.parse(body) as Record<string, unknown>[])
    body = toGeoJson(rowsArray)
  }

  if (req.method === 'HEAD') body = null

  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers,
  })
}
