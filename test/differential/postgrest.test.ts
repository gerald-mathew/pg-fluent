import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, loadFixture, pgClient, postgrestReady, pgrstGet } from './helpers.js'

const connected = await canConnect()
if (connected) await loadFixture()
const served = connected && (await postgrestReady())

/**
 * Differential tests: run the same logical request through a real PostgREST
 * server and through pg-fluent, then compare. These are the highest-value
 * tests for postgrest-js compatibility. They are skipped unless both a test
 * database (`PGFLUENT_TEST_URL`) and a PostgREST server
 * (`PGFLUENT_POSTGREST_URL`) are reachable; CI provides both.
 *
 * Intentional divergences are asserted explicitly and documented in
 * `EXPECTED_DIFFS.md` next to this file.
 */
describe.skipIf(!served)('PostgREST differential', () => {
  const db = pgClient()

  beforeAll(async () => {
    await loadFixture()
    if (!(await postgrestReady())) {
      throw new Error('PostgREST did not become ready after reloading the schema cache')
    }
  })

  afterAll(async () => {
    await db.close()
  })

  it('matches select, equality filter and ordering', async () => {
    const rest = await pgrstGet('pf_todos?select=id,task&done=eq.false&order=priority')
    const { data, error, status } = await db
      .from('pf_todos')
      .select('id, task')
      .eq('done', false)
      .order('priority')
    expect(rest.status).toBe(200)
    expect(status).toBe(200)
    expect(error).toBeNull()
    expect(data).toEqual(rest.body)
  })

  it('matches an embedded to-one relation', async () => {
    const rest = await pgrstGet('pf_posts?select=id,title,pf_users(name)&order=id')
    const { data, error } = await db.from('pf_posts').select('id, title, pf_users(name)').order('id')
    expect(rest.status).toBe(200)
    expect(error).toBeNull()
    expect(data).toEqual(rest.body)
  })

  it('matches an embedded filter when the embed is selected', async () => {
    const rest = await pgrstGet('pf_users?select=name,pf_posts!inner(title)&pf_posts.title=eq.hello')
    const { data, error } = await db
      .from('pf_users')
      .select('name, pf_posts!inner(title)')
      .eq('pf_posts.title', 'hello')
    expect(rest.status).toBe(200)
    expect(error).toBeNull()
    expect(data).toEqual(rest.body)
  })

  // PostgREST >= v16 rejects a dotted filter whose embed is not selected; pg-fluent
  // matches by rejecting too (with an actionable hint). See EXPECTED_DIFFS.md.
  it('rejects a dotted filter whose embed is not selected, like PostgREST', async () => {
    const rest = await pgrstGet('pf_posts?select=id&pf_users.name=eq.gerald')
    const { data, error, status } = await db.from('pf_posts').select('id').eq('pf_users.name', 'gerald')

    // Both refuse rather than silently returning unfiltered rows.
    expect(rest.status).toBe(400)
    expect(status).toBe(rest.status)
    expect(error?.code).toBe('PGRST100')
    expect(data).toBeNull()
  })

  // --- Intentional, documented divergence (see EXPECTED_DIFFS.md) ---

  it('diverges when a reserved parameter carries a filter value', async () => {
    const rest = await pgrstGet('pf_todos?select=id&columns=eq.1')
    const { error, status } = await db.from('pf_todos').select('id').eq('columns', 1)

    // PostgREST ignores `columns` on a read and returns every row.
    expect(rest.status).toBe(200)
    expect(Array.isArray(rest.body)).toBe(true)
    expect((rest.body as unknown[]).length).toBe(3)

    // pg-fluent rejects the reserved name outright.
    expect(status).toBe(400)
    expect(error?.code).toBe('PGFLUENT_INVALID_QUERY')
  })
})
