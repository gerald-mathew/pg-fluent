import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { expect } from 'vitest'
import { createClient } from '../../src/index.js'
import type { PgFluentClient, PgFluentConfig } from '../../src/index.js'

export const TEST_URL =
  process.env['PGFLUENT_TEST_URL'] ?? 'postgres://pgfluent:pgfluent@127.0.0.1:5432/pgfluent_test'

/**
 * Each test file owns a private schema in the shared test database. The schema
 * name is derived from the test file path, so it is stable across runs and
 * files never observe each other's fixture state, regardless of scheduling.
 */
function schemaName(): string {
  const testPath = expect.getState().testPath
  const base = testPath
    ? testPath.split('/').pop()!.replace(/\.test\.ts$/, '')
    : randomUUID().slice(0, 8)
  return `pf_test_${base.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60)
}

const SCHEMA = schemaName()

/** The private schema this test file owns (used by introspection tests). */
export const TEST_SCHEMA = SCHEMA

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export async function canConnect(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: TEST_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await pool.end()
  }
}

export async function resetFixture(): Promise<void> {
  const path = fileURLToPath(new URL('../fixtures/schema.sql', import.meta.url))
  const sql = await readFile(path, 'utf8')
  const pool = new pg.Pool({ connectionString: TEST_URL, max: 1, options: `-c search_path=${SCHEMA}` })
  const client = await pool.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(SCHEMA)}`)
    await client.query(`SET search_path TO ${quoteIdent(SCHEMA)}`)
    await client.query(sql)
  } finally {
    client.release()
    await pool.end()
  }
}

export function testClient(overrides: Partial<PgFluentConfig> = {}): PgFluentClient {
  return createClient({
    connectionString: TEST_URL,
    schemas: [SCHEMA],
    pool: { options: `-c search_path=${SCHEMA}` },
    ...overrides,
  } as PgFluentConfig)
}
