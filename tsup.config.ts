import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: 'node22',
  external: ['pg', 'pg-cursor', 'pg-copy-streams', '@opentelemetry/api', '@supabase/postgrest-js'],
})
