import { afterAll, expectTypeOf, it } from 'vitest'
import { createClient } from '../../src/index.js'
import type { PgFluentConfig } from '../../src/index.js'

interface Database {
  public: {
    Tables: {
      users: {
        Row: { id: number; name: string; active: boolean | null }
        Insert: { id?: number; name: string; active?: boolean | null }
        Update: { id?: number; name?: string; active?: boolean | null }
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

const db = createClient<Database>({ connectionString: 'postgres://user:pass@127.0.0.1:5432/none' })

it('accepts a generated Database generic', () => {
  const config: PgFluentConfig = { connectionString: 'postgres://localhost/none' }
  expectTypeOf(config).toMatchTypeOf<PgFluentConfig>()
  expectTypeOf(db.from).toBeFunction()
})

it('infers row types from the select string', () => {
  const query = db.from('users').select('id, name')
  type Data = Awaited<typeof query>['data']
  type Row = NonNullable<Data>[number]
  expectTypeOf<Row['id']>().toEqualTypeOf<number>()
  expectTypeOf<Row['name']>().toEqualTypeOf<string>()
  expectTypeOf<Data>().not.toBeAny()
})

it('types writable payloads from Insert/Update', () => {
  const inserted = db.from('users').insert({ name: 'G' })
  expectTypeOf(inserted).not.toBeAny()
  const updated = db.from('users').update({ active: true })
  expectTypeOf(updated).not.toBeAny()
})

it('exposes typed client extras', () => {
  expectTypeOf(db.transaction).toBeFunction()
  expectTypeOf(db.copyFrom).toBeFunction()
  expectTypeOf(db.listen).toBeFunction()
  expectTypeOf(db.$pool).not.toBeAny()
})

afterAll(async () => {
  await db.close()
})
