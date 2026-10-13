import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const base = pathToFileURL(root)

let failed = false

for (const file of ['dist/index.js', 'dist/cli.js']) {
  const source = await readFile(new URL(file, base), 'utf8')
  if (/__require\(/.test(source) || /Dynamic require of/.test(source)) {
    console.error(
      `${file}: contains a CJS require() shim. An ESM entry point must not bundle require() calls ` +
        `(mark the dependency external or use import).`
    )
    failed = true
  }
}

for (const [file, loader] of [
  ['dist/index.js', 'esm'],
  ['dist/index.cjs', 'cjs'],
]) {
  try {
    const mod =
      loader === 'esm'
        ? await import(new URL(file, base).href)
        : createRequire(new URL('package.json', base))(`./${file}`)
    if (typeof mod.createClient !== 'function') {
      console.error(`${file} did not export createClient()`)
      failed = true
    }
  } catch (err) {
    console.error(`${file} failed to load as ${loader}: ${err.message}`)
    failed = true
  }
}

if (failed) process.exit(1)
console.log('dist bundle check: ESM and CJS entry points load without CJS shims.')
