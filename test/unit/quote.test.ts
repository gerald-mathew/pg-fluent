import { describe, expect, it } from 'vitest'
import { quoteCast, quoteIdent, quoteQualified } from '../../src/sql/quote.js'
import { PgFluentError } from '../../src/errors/index.js'

describe('quoteIdent', () => {
  it('double-quotes and escapes', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
    expect(quoteIdent('a.b')).toBe('"a.b"')
  })

  it('rejects empty, NUL and over-long names', () => {
    expect(() => quoteIdent('')).toThrow(PgFluentError)
    expect(() => quoteIdent('a\u0000b')).toThrow(PgFluentError)
    expect(() => quoteIdent('x'.repeat(64))).toThrow(PgFluentError)
  })

  it('qualifies schema and name', () => {
    expect(quoteQualified('public', 'users')).toBe('"public"."users"')
  })
})

describe('quoteCast', () => {
  it('quotes simple and qualified types', () => {
    expect(quoteCast('text')).toBe('"text"')
    expect(quoteCast('public.mytype')).toBe('"public"."mytype"')
    expect(quoteCast('int[]')).toBe('"int"[]')
  })

  it('rejects injection attempts', () => {
    expect(() => quoteCast('text); drop table users; --')).toThrow(PgFluentError)
    expect(() => quoteCast('text[]; --')).toThrow(PgFluentError)
  })
})
