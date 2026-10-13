// Reproducible benchmark harness: pg-fluent vs raw `pg` on identical data.
//
// This harness deliberately publishes NO performance claims. It reports
// methodology and measured medians/variance so numbers can be reproduced on
// your own hardware. Network topology, pooling and server configuration all
// affect the result; do not generalize from a single run.
//
// Usage:
//   npm run build
//   PGFLUENT_BENCH_URL=postgres://user:pass@host:5432/db node bench/bench.mjs
//
// Env:
//   PGFLUENT_BENCH_URL   target database (falls back to PGFLUENT_TEST_URL)
//   BENCH_ROWS           rows to seed (default 50000)
//   BENCH_ITERATIONS     timed iterations per case (default 30)

import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { createClient } from '../dist/index.js'

const url = process.env.PGFLUENT_BENCH_URL ?? process.env.PGFLUENT_TEST_URL
if (!url) {
  console.error('Set PGFLUENT_BENCH_URL (or PGFLUENT_TEST_URL) to run the benchmark.')
  process.exit(1)
}

const rows = Number(process.env.BENCH_ROWS ?? 50_000)
const iterations = Number(process.env.BENCH_ITERATIONS ?? 30)
const TABLE = 'pgfluent_bench_events'

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length
  return { median, p95, stddev: Math.sqrt(variance) }
}

async function time(label, fn, setup) {
  for (let i = 0; i < Math.min(5, iterations); i++) await fn() // warmup
  const samples = []
  for (let i = 0; i < iterations; i++) {
    if (setup) await setup()
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  const { median, p95, stddev } = stats(samples)
  console.log(
    `${label.padEnd(34)} median ${median.toFixed(2)}ms  p95 ${p95.toFixed(2)}ms  σ ${stddev.toFixed(2)}ms`
  )
}

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 10 })
  const db = createClient({ connectionString: url, maxRows: Infinity })

  console.log(`pg-fluent benchmark — rows=${rows} iterations=${iterations}`)
  console.log('(methodology only; no conclusions about relative performance)\n')

  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
  await pool.query(`CREATE TABLE ${TABLE} (id bigserial PRIMARY KEY, kind text NOT NULL, value int NOT NULL)`)
  await pool.query(
    `INSERT INTO ${TABLE} (kind, value)
     SELECT 'kind-' || (g % 8), g FROM generate_series(1, $1) AS g`,
    [rows]
  )

  try {
    await time('raw pg: SELECT all rows', async () => {
      await pool.query(`SELECT id, kind, value FROM ${TABLE} ORDER BY id`)
    })

    await time('pg-fluent: SELECT all rows', async () => {
      const { error } = await db.from(TABLE).select('id, kind, value').order('id')
      if (error) throw error
    })

    await time('pg-fluent: filtered + limited', async () => {
      const { error } = await db.from(TABLE).select('id, value').gt('value', rows / 2).limit(100)
      if (error) throw error
    })

    await time('pg-fluent: .toSQL() only', async () => {
      await db.from(TABLE).select('id').eq('kind', 'kind-1').order('id').toSQL()
    })

    await time(
      'raw pg: INSERT (one row)',
      async () => {
        await pool.query(`INSERT INTO ${TABLE} (kind, value) VALUES ('x', 1)`)
      },
      () => pool.query(`TRUNCATE ${TABLE}`)
    )

    await time('pg-fluent: insert (one row)', async () => {
      const { error } = await db.from(TABLE).insert({ kind: 'x', value: 1 })
      if (error) throw error
    })
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await db.close()
    await pool.end()
  }
}

await main()
