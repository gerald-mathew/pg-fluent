import { describe, expect, it } from 'vitest'
import { createClient } from '../../src/client.js'

describe('client options', () => {
  it('rejects an invalid maxRows', () => {
    expect(() => createClient({ maxRows: 1.5 })).toThrow(/maxRows/)
    expect(() => createClient({ maxRows: -1 })).toThrow(/maxRows/)
    expect(() => createClient({ maxRows: Number.NaN })).toThrow(/maxRows/)
  })

  it('accepts Infinity and zero', async () => {
    const infinite = createClient({ maxRows: Infinity })
    const zero = createClient({ maxRows: 0 })
    try {
      expect(infinite).toBeDefined()
      expect(zero).toBeDefined()
    } finally {
      await infinite.close()
      await zero.close()
    }
  })
})

describe('extensions', () => {
  it('rejects an unsafe timeout', async () => {
    const db = createClient({ connectionString: 'postgres://pgfluent:pgfluent@127.0.0.1:1/test' })
    try {
      expect(() => db.from('todos').select('id').timeout(1e21)).toThrow(/Timeout/)
      expect(() => db.from('todos').select('id').timeout(1.5)).toThrow(/Timeout/)
    } finally {
      await db.close()
    }
  })
})
