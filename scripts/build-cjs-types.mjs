import { readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full)
    } else if (entry.name.endsWith('.d.ts')) {
      const source = await readFile(full, 'utf8')
      const rewritten = source.replace(
        /(from\s+['"])(\.\.?\/[^'"]+)\.js(['"])/g,
        '$1$2.cjs$3'
      )
      await writeFile(full.replace(/\.d\.ts$/, '.d.cts'), rewritten)
    }
  }
}

await walk(dist)
