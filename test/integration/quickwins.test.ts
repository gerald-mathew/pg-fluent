import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('phase 0 quick wins', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })
  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close({ timeoutMs: 5000 })
  })

  it('.allowUnfiltered() permits an unfiltered delete', async () => {
    const { status, error } = await db.from('pf_places').delete().allowUnfiltered()
    expect(status).toBe(204)
    expect(error).toBeNull()
    const remaining = await db.from('pf_places').select('id')
    expect(remaining.data).toEqual([])
  })

  it('.allowUnfiltered() permits an unfiltered update', async () => {
    const { status } = await db
      .from('pf_places')
      .update({ name: 'renamed' })
      .allowUnfiltered()
      .select('name')
    expect(status).toBe(200)
    const { data } = await db.from('pf_places').select('name')
    expect(data).toEqual([{ name: 'renamed' }, { name: 'renamed' }])
  })

  it('still refuses unfiltered mutations by default', async () => {
    const { status, error } = await db.from('pf_places').delete()
    expect(status).toBe(400)
    expect(error?.code).toBe('PGFLUENT_UNFILTERED_MUTATION')
  })

  it('.timeout(ms) cancels a slow statement with PGFLUENT_TIMEOUT', async () => {
    const { error, status } = await db.rpc('pf_sleep', { ms: 300 }).timeout(30)
    expect(status).toBe(504)
    expect(error?.code).toBe('57014')
  })

  it('.timeout(ms) allows a fast statement through', async () => {
    const { data, status } = await db.rpc('pf_sleep', { ms: 1 }).timeout(2000)
    expect(status).toBe(200)
    expect(data).toBe(1)
  })

  it('trx.savepoint() rolls back only the nested work', async () => {
    const result = await db.transaction(async (trx) => {
      await trx.from('pf_places').insert({ name: 'outer' })
      await trx
        .savepoint(async (sp) => {
          await sp.from('pf_places').insert({ name: 'inner' })
          throw new Error('boom')
        })
        .catch(() => undefined)
      return trx.from('pf_places').select('name').order('name')
    })
    const names = (result.data ?? []).map((r: { name: string }) => r.name)
    expect(names).toContain('outer')
    expect(names).not.toContain('inner')
  })

  it('returns a GeoJSON FeatureCollection', async () => {
    const { data, status } = await db.from('pf_places').select('name, geometry').geojson()
    expect(status).toBe(200)
    const collection = data as unknown as {
      type: string
      features: Array<{ geometry: { type: string }; properties: { name: string } }>
    }
    expect(collection.type).toBe('FeatureCollection')
    expect(collection.features).toHaveLength(2)
    expect(collection.features[0]!.geometry.type).toBe('Point')
    expect(collection.features[0]!.properties.name).toBe('origin')
  })

  it('rejects GeoJSON output without a geometry column', async () => {
    const { status, error } = await db.from('pf_todos').select('task').geojson()
    expect(status).toBe(400)
    expect(error?.code).toBe('PGFLUENT_INVALID_QUERY')
  })

  it('missing=default applies column defaults for absent keys', async () => {
    const { data, error, status } = await db
      .from('pf_todos')
      .insert([{ task: 'a', done: true }, { task: 'b' }], { defaultToNull: false })
      .select('task, done, priority')
      .order('task')
    expect(error).toBeNull()
    expect(status).toBe(201)
    expect(data).toEqual([
      { task: 'a', done: true, priority: null },
      { task: 'b', done: false, priority: null },
    ])
  })
})
