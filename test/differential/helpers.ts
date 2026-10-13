import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '../../src/index.js'
import type { PgFluentClient } from '../../src/index.js'

export const TEST_URL =
  process.env['PGFLUENT_TEST_URL'] ?? 'postgres://pgfluent:pgfluent@127.0.0.1:5432/pgfluent_test'

/**
 * The schema exposed by the PostgREST service used for differential testing.
 * Must match `PGRST_DB_SCHEMAS` in `.github/workflows/ci.yml`.
 */
export const DIFF_SCHEMA = process.env['PGFLUENT_DIFF_SCHEMA'] ?? 'pf_diff'

/** Base URL of the PostgREST server, e.g. `http://127.0.0.1:3000`. Unset => tests skip. */
export const POSTGREST_URL = process.env['PGFLUENT_POSTGREST_URL']

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

/**
 * Load the shared fixture into {@link DIFF_SCHEMA} and ask PostgREST to reload
 * its schema cache so it sees the freshly (re)created objects.
 */
export async function loadFixture(): Promise<void> {
  const path = fileURLToPath(new URL('../fixtures/schema.sql', import.meta.url))
  const sql = await readFile(path, 'utf8')
  const pool = new pg.Pool({
    connectionString: TEST_URL,
    max: 1,
    options: `-c search_path=${DIFF_SCHEMA}`,
  })
  const client = await pool.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${DIFF_SCHEMA}"`)
    await client.query(`SET search_path TO "${DIFF_SCHEMA}"`)
    await client.query(sql)
    await client.query(`NOTIFY pgrst, 'reload schema'`)
  } finally {
    client.release()
    await pool.end()
  }
}

/** A pg-fluent client that runs SQL directly against {@link DIFF_SCHEMA}. */
export function pgClient(): PgFluentClient {
  return createClient({
    connectionString: TEST_URL,
    schemas: [DIFF_SCHEMA],
    pool: { options: `-c search_path=${DIFF_SCHEMA}` },
  })
}

export interface PgrstResponse {
  status: number
  body: unknown
  text: string
}

/** Issue a GET against the PostgREST server. `pathAndQuery` has no leading slash. */
export async function pgrstGet(pathAndQuery: string): Promise<PgrstResponse> {
  if (POSTGREST_URL === undefined) throw new Error('PGFLUENT_POSTGREST_URL is not set')
  const res = await fetch(`${POSTGREST_URL.replace(/\/+$/, '')}/${pathAndQuery}`, {
    headers: { Accept: 'application/json' },
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Leave non-JSON error pages as text.
  }
  return { status: res.status, body, text }
}

/**
 * Poll until PostgREST answers a trivial query for the fixture table, which
 * implies it has picked up the reloaded schema cache. Returns false on timeout.
 */
export async function postgrestReady(table = 'pf_todos', timeoutMs = 20_000): Promise<boolean> {
  if (POSTGREST_URL === undefined) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await pgrstGet(`${table}?select=id&limit=1`)
      if (res.status === 200) return true
    } catch {
      // Server not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}
