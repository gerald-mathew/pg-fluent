import { describe, expect, it } from 'vitest'
import { redactConnectionString, redactSecrets } from '../../src/errors/redact.js'

describe('redactSecrets', () => {
  it('masks passwords in connection URIs', () => {
    const out = redactSecrets('failed to connect to postgres://user:s3cret@host:5432/db')
    expect(out).not.toContain('s3cret')
    expect(out).toContain('postgres://user:****@host:5432/db')
  })

  it('masks keyword passwords', () => {
    const out = redactSecrets('password=hunter2 host=localhost')
    expect(out).not.toContain('hunter2')
  })

  it('leaves ordinary messages untouched', () => {
    expect(redactSecrets('duplicate key value violates unique constraint')).toBe(
      'duplicate key value violates unique constraint'
    )
  })
})

describe('redactConnectionString', () => {
  it('keeps the host while masking the password', () => {
    const out = redactConnectionString('postgres://u:p@h:5432/d')
    expect(out).toContain('h:5432')
    expect(out).not.toContain(':p@')
  })

  it('falls back to regex redaction for non-URL strings', () => {
    expect(redactConnectionString('postgres://u:p@h/d')).not.toContain(':p@')
  })
})
