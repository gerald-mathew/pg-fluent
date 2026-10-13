import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('explain', () => {
  const db = testClient()

  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('returns the text plan without executing', async () => {
    const { data, error, status } = await db.from('pf_todos').select('*').explain()
    expect(status).toBe(200)
    expect(error).toBeNull()
    expect(typeof data).toBe('string')
    expect(data as string).toContain('pf_todos')
  })

  it('analyzes and executes the query', async () => {
    const { data } = await db.from('pf_todos').select('id').explain({ analyze: true, buffers: true })
    expect(data as string).toMatch(/actual time|never executed/)
    expect(data as string).toContain('Buffers:')
  })

  it('returns JSON plans', async () => {
    const { data } = await db
      .from('pf_todos')
      .select('id')
      .explain({ analyze: true, format: 'json' })
    expect(Array.isArray(data)).toBe(true)
    expect(JSON.stringify(data)).toContain('Plan')
  })

  it('rolls back analyzed mutations', async () => {
    const { error } = await db
      .from('pf_todos')
      .update({ done: true })
      .eq('id', 2)
      .explain({ analyze: true })
    expect(error).toBeNull()
    const { data } = await db.from('pf_todos').select('done').eq('id', 2).single()
    expect(data).toEqual({ done: false })
  })
})
