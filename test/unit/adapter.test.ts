import { describe, expect, it } from 'vitest'
import { createFetchAdapter } from '../../src/adapter/fetch.js'
import type { Executor, QueryResult, RouteContext, TransactionOptions } from '../../src/exec/executor.js'

const ctx = { schemas: ['public'], defaultSchema: 'public' }

function adapter(fail: (text: string) => Error | undefined) {
  const calls: string[] = []
  const executor: Executor = {
    async query(text: string, _values?: unknown[], _ctx?: RouteContext): Promise<QueryResult> {
      calls.push(text)
      const error = fail(text)
      if (error) throw error
      return { rows: [{ __pgfl_body: '[]', __pgfl_returned: 0 }], rowCount: 1 }
    },
    async transaction<T>(
      fn: (tx: Executor) => Promise<T>,
      _options?: TransactionOptions
    ): Promise<T> {
      return fn(executor)
    },
  }
  return {
    fetch: createFetchAdapter({
      executor,
      schemas: ctx.schemas,
      defaultSchema: ctx.defaultSchema,
      maxRows: 1000,
      allowUnfilteredMutations: false,
    }),
    calls,
  }
}

function timeoutError(): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

describe('count failures', () => {
  it('returns an error when the planner estimate statement fails', async () => {
    const { fetch, calls } = adapter((text) =>
      text.startsWith('EXPLAIN') ? timeoutError() : undefined
    )

    const res = await fetch('http://pg-fluent.local/todos?select=id', {
      method: 'GET',
      headers: { Prefer: 'count=planned' },
    })

    expect(calls.some((text) => text.startsWith('EXPLAIN'))).toBe(true)
    expect(res.status).toBe(504)
    expect(await body(res)).toMatchObject({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })
  })

  it('returns an error when the exact count statement fails', async () => {
    const { fetch, calls } = adapter((text) =>
      text.includes('count(*)') ? timeoutError() : undefined
    )

    const res = await fetch('http://pg-fluent.local/todos?select=id', {
      method: 'GET',
      headers: { Prefer: 'count=estimated' },
    })

    expect(calls.some((text) => text.includes('count(*)'))).toBe(true)
    expect(res.status).toBe(504)
    expect(await body(res)).toMatchObject({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })
  })
})
