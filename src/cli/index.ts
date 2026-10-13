#!/usr/bin/env node
import { runGenTypes } from './gen-types.js'

const args = process.argv.slice(2)
if (args[0] === 'gen-types') args.shift()

runGenTypes(args).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`pg-fluent gen-types: ${message}\n`)
  process.exitCode = 1
})
