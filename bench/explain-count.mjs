// Opt-in EXPLAIN ANALYZE comparison for the filter CTE used by counted reads.
//
// pg-fluent emits `WITH ... AS NOT MATERIALIZED` so PostgreSQL can fold the
// filtered CTE into the parent query. This script measures the generated
// statement as-is and again with `AS MATERIALIZED`, on a seeded table, so a
// planner change can be compared on your own hardware. It publishes NO
// performance claims: results depend on data distribution, indexes, server
// settings and hardware.
//
// Usage:
//   npm run build
//   PGFLUENT_BENCH_URL=postgres://user:pass@host:5432/db node bench/explain-count.mjs
//
// Env:
//   PGFLUENT_BENCH_URL   target database (falls back to PGFLUENT_TEST_URL)
//   BENCH_ROWS           rows to seed (default 200000)
//   BENCH_ITERATIONS     EXPLAIN ANALYZE runs per variant (default 5)

import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { createClient } from '../dist/index.js'

const url = process.env.PGFLUENT_BENCH_URL ?? process.env.PGFLUENT_TEST_URL
if (!url) {
  console.error('Set PGFLUENT_BENCH_URL (or PGFLUENT_TEST_URL) to run the benchmark.')
  process.exit(1)
}

const rows = Number(process.env.BENCH_ROWS ?? 200_000)
const iterations = Number(process.env.BENCH_ITERATIONS ?? 5)
const TABLE = 'pgfluent_bench_count'

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length
  return { median, p95, stddev: Math.sqrt(variance) }
}

function planFrom(result) {
  const raw = result.rows[0]?.['QUERY PLAN']
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  return parsed?.[0] ?? {}
}

async function explain(pool, label, sql, values) {
  const samples = []
  let plan
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values)
    samples.push(performance.now() - start)
    plan = planFrom(result)
  }
  const { median, p95, stddev } = stats(samples)
  const execution = Number(plan['Execution Time'] ?? 0)
  const planning = Number(plan['Planning Time'] ?? 0)
  const root = plan.Plan ?? {}
  const buffers = root['Shared Hit Blocks'] ?? 0
  console.log(
    `${label.padEnd(26)} median ${median.toFixed(2)}ms  p95 ${p95.toFixed(2)}ms  σ ${stddev.toFixed(2)}ms  ` +
      `server ${execution.toFixed(2)}ms (plan ${planning.toFixed(2)}ms)  buffers ${buffers}`
  )
  return { median, execution, planning, buffers }
}

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  const db = createClient({ connectionString: url, maxRows: Infinity })

  console.log(`pg-fluent filter CTE benchmark — rows=${rows} iterations=${iterations}`)
  console.log('(methodology only; no conclusions about relative performance)\n')

  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
  await pool.query(
    `CREATE TABLE ${TABLE} (id bigserial PRIMARY KEY, kind text NOT NULL, value int NOT NULL)`
  )
  await pool.query(
    `INSERT INTO ${TABLE} (kind, value)
     SELECT 'kind-' || (g % 8), g FROM generate_series(1, $1) AS g`,
    [rows]
  )
  await pool.query(`ANALYZE ${TABLE}`)

  try {
    // `count=exact` forces the filtered CTE; `.toSQL()` exposes the executable
    // statement (data + count) without running it.
    const { text, values } = await db
      .from(TABLE)
      .select('id, kind, value', { count: 'exact' })
      .gt('value', Math.floor(rows / 2))
      .order('id')
      .limit(100)
      .toSQL()

    const materialized = text.includes('AS NOT MATERIALIZED')
      ? text.replace('AS NOT MATERIALIZED', 'AS MATERIALIZED')
      : text

    if (materialized === text) {
      console.error('Generated SQL did not contain "AS NOT MATERIALIZED"; nothing to compare.')
      process.exitCode = 1
      return
    }

    await explain(pool, 'NOT MATERIALIZED (as emitted)', text, values)
    await explain(pool, 'MATERIALIZED (forced)', materialized, values)
    console.log('\nCompare medians across repeated runs; single runs are noisy.')
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await db.close()
    await pool.end()
  }
}

await main()
