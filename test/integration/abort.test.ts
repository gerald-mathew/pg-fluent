import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('abortSignal', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })

  afterAll(async () => {
    await db.close()
  })

  it('cancels an in-flight statement and reports PGFLUENT_ABORTED', async () => {
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 40)
    const { error } = await db.rpc('pf_sleep', { ms: 2000 }).abortSignal(controller.signal)
    const elapsed = Date.now() - start
    expect(error?.code).toBe('PGFLUENT_ABORTED')
    expect(elapsed).toBeLessThan(1500)
  })

  it('short-circuits an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { error } = await db.rpc('pf_add', { a: 1, b: 2 }).abortSignal(controller.signal)
    expect(error?.code).toBe('PGFLUENT_ABORTED')
  })
})
