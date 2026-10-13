import { describe, expect, it } from 'vitest'
import { toCsv, toCsvField } from '../../src/response/csv.js'

describe('toCsvField', () => {
  it('renders null, boolean, number and string', () => {
    expect(toCsvField(null)).toBe('')
    expect(toCsvField(undefined)).toBe('')
    expect(toCsvField(true)).toBe('true')
    expect(toCsvField(42)).toBe('42')
    expect(toCsvField('plain')).toBe('plain')
  })

  it('quotes fields containing separators or quotes', () => {
    expect(toCsvField('a,b')).toBe('"a,b"')
    expect(toCsvField('he said "hi"')).toBe('"he said ""hi"""')
    expect(toCsvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('serializes arrays and objects as JSON', () => {
    expect(toCsvField(['a', 'b'])).toBe('"[""a"",""b""]"')
    expect(toCsvField({ a: 1 })).toBe('"{""a"":1}"')
  })
})

describe('toCsv', () => {
  it('emits a header from explicit columns and one row per record', () => {
    expect(toCsv([{ id: 1, task: 'a,b' }], ['id', 'task'])).toBe('id,task\n1,"a,b"\n')
  })

  it('derives headers from row keys in first-seen order', () => {
    const csv = toCsv([{ b: 1, a: 2 }, { a: 3, c: 4 }])
    expect(csv).toBe('b,a,c\n1,2,\n,3,4\n')
  })
})
