/**
 * Ambient types for the optional peer `pg-copy-streams`. When consumers
 * install the real package, its own declarations take precedence and this
 * declaration is inert.
 */
declare module 'pg-copy-streams' {
  import type { Transform } from 'node:stream'
  export function from(sql: string): Transform
  export function to(sql: string, opts?: unknown): Transform
  export function copyFrom(sql: string): Transform
  export function copyTo(sql: string, opts?: unknown): Transform
}