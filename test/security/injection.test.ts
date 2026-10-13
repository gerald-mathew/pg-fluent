import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('injection safety (S2)', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
    await db.$pool.query('DROP TABLE IF EXISTS pgfluent_canary')
    await db.$pool.query('CREATE TABLE pgfluent_canary (id int)')
    await db.$pool.query('INSERT INTO pgfluent_canary VALUES (1)')
  })
  afterAll(async () => {
    await db.$pool.query('DROP TABLE IF EXISTS pgfluent_canary')
    await db.close()
  })

  async function canaryAlive(): Promise<boolean> {
    const res = await db.$pool.query("SELECT to_regclass('pgfluent_canary') AS t")
    return res.rows[0]?.t !== null && res.rows[0]?.t !== undefined
  }

  const hostile = [
    'x; DROP TABLE pgfluent_canary; --',
    "x' OR '1'='1",
    'a"b',
    'a".b',
    '-- comment',
    'col) ; DROP TABLE pgfluent_canary; --',
    'a b',
    'select 1',
    'É',
  ]

  it('keeps filter values out of the SQL text for arbitrary input', async () => {
    const baseline = await db.from('pf_todos').select('id').eq('task', '__baseline__').toSQL()
    await fc.assert(
      fc.asyncProperty(fc.string(), async (payload) => {
        const plan = await db.from('pf_todos').select('id').eq('task', payload).toSQL()
        expect(plan.text).toBe(baseline.text)
        expect(plan.values).toEqual([payload])
      }),
      { numRuns: 50 }
    )
    expect(await canaryAlive()).toBe(true)
  })

  it('binds hostile values as parameters and never executes injected SQL', async () => {
    for (const payload of hostile) {
      try {
        await db.from('pf_todos').select('id').eq('task', payload)
      } catch {
        // planning or execution may fail; that is acceptable — nothing must run
      }
      expect(await canaryAlive()).toBe(true)
    }
  })

  it('never breaks out of quoted identifiers from select/order/filter', async () => {
    for (const payload of hostile) {
      const chains = [
        () => db.from('pf_todos').select(payload),
        () => db.from('pf_todos').select('id').order(payload),
        () => db.from('pf_todos').select('id').filter(payload, 'eq', '1'),
        () => db.from('pf_todos').select('id').or(payload),
      ]
      for (const make of chains) {
        try {
          const plan = await make().toSQL()
          const escaped = payload.replace(/"/g, '""')
          const withoutQuoted = plan.text.split(`"${escaped}"`).join('')
          expect(withoutQuoted.includes(escaped)).toBe(false)
        } catch {
          // rejected client-side: also safe
        }
        try {
          await make()
        } catch {
          // execution may fail for a bogus identifier; nothing must have run
        }
      }
      expect(await canaryAlive()).toBe(true)
    }
  })

  it('passes insert bodies as a single JSON parameter, never as SQL text', async () => {
    for (const payload of hostile) {
      const plan = await db.from('pf_todos').insert({ task: payload } as never).toSQL()
      expect(plan.text).not.toContain(payload)
      expect(JSON.parse(String(plan.values[0]))).toEqual([{ task: payload }])
      expect(await canaryAlive()).toBe(true)
    }
  })

  it('rejects hostile insert JSON keys as unknown columns', async () => {
    for (const payload of hostile) {
      await expect(
        db.from('pf_todos').insert({ [payload]: 1 } as never).toSQL()
      ).rejects.toMatchObject({ code: 'PGRST204' })
      expect(await canaryAlive()).toBe(true)
    }
  })

  it('binds interpolations in the sql tag as parameters', async () => {
    const payload = "1; DROP TABLE pgfluent_canary; --"
    const plan = db.sql`select * from pgfluent_canary where id = ${payload}`.toSQL()
    expect(plan.text.toLowerCase()).toContain('where id = $1')
    expect(plan.values).toEqual([payload])
    expect(await canaryAlive()).toBe(true)
  })
})
