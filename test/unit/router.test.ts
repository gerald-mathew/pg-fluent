import { describe, expect, it } from 'vitest'
import { RoutingExecutor } from '../../src/connections/router.js'
import type { Executor, QueryResult, RouteContext, TransactionOptions } from '../../src/exec/executor.js'

const RESULT: QueryResult = { rows: [{ n: 1 }], rowCount: 1 }

function recording(label: string, fail?: Error) {
  const calls: { text: string; ctx?: RouteContext }[] = []
  const executor: Executor = {
    async query(text: string, values?: unknown[], ctx?: RouteContext): Promise<QueryResult> {
      calls.push({ text, ctx })
      if (fail !== undefined) throw fail
      return RESULT
    },
    async transaction<T>(fn: (tx: Executor) => Promise<T>, _options?: TransactionOptions): Promise<T> {
      return fn(executor)
    },
  }
  return { executor, calls }
}

const CONNECTION_ERROR = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })

describe('RoutingExecutor', () => {
  it('routes reads to a replica when no special context is set', async () => {
    const primary = recording('primary')
    const replica = recording('replica')
    const routing = new RoutingExecutor({ primary: primary.executor, replicas: [replica.executor] })

    await routing.query('SELECT 1', [], {})

    expect(replica.calls).toHaveLength(1)
    expect(primary.calls).toHaveLength(0)
  })

  it('routes to primary when no context is supplied', async () => {
    const primary = recording('primary')
    const replica = recording('replica')
    const routing = new RoutingExecutor({ primary: primary.executor, replicas: [replica.executor] })

    await routing.query('SELECT 1')

    expect(primary.calls).toHaveLength(1)
    expect(replica.calls).toHaveLength(0)
  })

  it('routes to primary for writes, transactions and forcePrimary reads', async () => {
    const primary = recording('primary')
    const replica = recording('replica')
    const routing = new RoutingExecutor({ primary: primary.executor, replicas: [replica.executor] })

    await routing.query('UPDATE t SET a = 1', [], { isWrite: true })
    await routing.query('SELECT 1', [], { forcePrimary: true })
    await routing.transaction(async (tx) => tx.query('SELECT 2'))

    expect(primary.calls).toHaveLength(3)
    expect(replica.calls).toHaveLength(0)
  })

  it('routes streamed reads to a replica', async () => {
    const primary = recording('primary')
    const replica = recording('replica')
    replica.executor.stream = async function* () {
      yield { n: 1 }
    }
    const routing = new RoutingExecutor({ primary: primary.executor, replicas: [replica.executor] })

    const rows: unknown[] = []
    for await (const row of routing.stream('SELECT 1', [], {})) rows.push(row)

    expect(rows).toEqual([{ n: 1 }])
    expect(primary.calls).toHaveLength(0)
  })

  it('falls back to primary on a replica connection error and cools it down', async () => {
    const primary = recording('primary')
    const replica = recording('replica', CONNECTION_ERROR)
    const routing = new RoutingExecutor({ primary: primary.executor, replicas: [replica.executor] })

    await routing.query('SELECT 1', [], {})

    expect(replica.calls).toHaveLength(1)
    expect(primary.calls).toHaveLength(1)

    // The replica is cooling down; the next read must skip it.
    await routing.query('SELECT 2', [], {})
    expect(primary.calls).toHaveLength(2)
    expect(replica.calls).toHaveLength(1)
  })

  it('does not fall back on query errors', async () => {
    const primary = recording('primary')
    const replica = recording('replica', new Error('undefined_column'))
    const routing = new RoutingExecutor({ primary: primary.executor, replicas: [replica.executor] })

    await expect(routing.query('SELECT nope', [], {})).rejects.toThrow('undefined_column')
    expect(primary.calls).toHaveLength(0)
  })
})