import { describe, expect, it } from 'vitest'
import { isTransientError, withRetry } from '../../src/exec/retry.js'

function transient(): Error {
  return Object.assign(new Error('connection reset'), { code: '08006' })
}

describe('withRetry', () => {
  it('retries transient failures and counts physical attempts', async () => {
    let calls = 0
    const { value, attempts } = await withRetry({ max: 2, backoffMs: 1 }, async () => {
      calls += 1
      if (calls < 3) throw transient()
      return 'ok'
    })
    expect(value).toBe('ok')
    expect(attempts).toBe(3)
    expect(calls).toBe(3)
  })

  it('does not retry non-transient errors', async () => {
    let calls = 0
    await expect(
      withRetry({ max: 2, backoffMs: 1 }, async () => {
        calls += 1
        throw Object.assign(new Error('duplicate key'), { code: '23505' })
      })
    ).rejects.toThrow('duplicate key')
    expect(calls).toBe(1)
  })

  it('gives up after max attempts', async () => {
    let calls = 0
    await expect(
      withRetry({ max: 1, backoffMs: 0 }, async () => {
        calls += 1
        throw transient()
      })
    ).rejects.toThrow('connection reset')
    expect(calls).toBe(2)
  })
})

describe('isTransientError', () => {
  it('classifies connection and shutdown errors', () => {
    expect(isTransientError({ code: '08006' })).toBe(true)
    expect(isTransientError({ code: '57P01' })).toBe(true)
    expect(isTransientError({ code: '57P03' })).toBe(true)
    expect(isTransientError({ code: '23505' })).toBe(false)
    expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(true)
    expect(isTransientError(null)).toBe(false)
  })
})
