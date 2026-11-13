import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('.toSQL()', () => {
  const db = testClient()

  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('renders a select with bound values', async () => {
    const plan = await db.from('pf_todos').select('id, task').eq('done', false).toSQL()
    expect(plan.text).not.toContain('pgfl_filtered')
    expect(plan.text).toContain('"pf_todos" AS "pgfl_base"')
    expect(plan.text).toContain('WHERE')
    expect(plan.values).toEqual(['false'])
  })

  it('returns executable data SQL', async () => {
    const plan = await db
      .from('pf_todos')
      .select('id, task')
      .eq('done', false)
      .toSQL({ shape: 'data' })
    expect(plan.text).not.toContain('json_agg')
    expect(plan.text).not.toContain('row_to_json')
    const { data } = await db.unsafe(plan.text, plan.values)
    expect(data).toHaveLength(2)
  })

  it('renders an insert as a single JSON parameter', async () => {
    const plan = await db.from('pf_todos').insert({ task: 'buy milk' }).toSQL()
    expect(plan.text.toUpperCase()).toContain('INSERT INTO')
    expect(plan.values).toHaveLength(1)
  })

  it('renders an update with a filter', async () => {
    const plan = await db.from('pf_todos').update({ done: true }).eq('id', 1).toSQL()
    expect(plan.text.toUpperCase()).toContain('UPDATE')
    expect(plan.text).toContain('WHERE')
    expect(plan.values).toEqual(['{"done":true}', '1'])
  })

  it('renders an rpc call', async () => {
    const plan = await db.rpc('pf_add', { a: 2, b: 3 }).toSQL()
    expect(plan.text).toContain('"pf_add"')
    expect(plan.values).toEqual([2, 3])
  })

  it('does not execute the statement', async () => {
    await db.from('pf_todos').insert({ task: 'not persisted' }).toSQL()
    const { count } = await db.from('pf_todos').select('*', { count: 'exact', head: true })
    expect(count).toBe(3)
  })

  it('throws with a code when planning fails', async () => {
    await expect(db.from('pf_todos').delete().toSQL()).rejects.toMatchObject({
      code: 'PGFLUENT_UNFILTERED_MUTATION',
    })
  })
})
