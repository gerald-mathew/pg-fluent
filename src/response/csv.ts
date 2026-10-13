export type CsvValue = unknown

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function toCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return escapeField(value)
  return escapeField(JSON.stringify(value))
}

/** Serialize JSON row objects to PostgREST-style CSV. */
export function toCsv(rows: Record<string, CsvValue>[], columns?: string[]): string {
  const header = columns ? [...columns] : []
  if (!columns) {
    const seen = new Set<string>()
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key)
          header.push(key)
        }
      }
    }
  }
  const lines: string[] = [header.map(escapeField).join(',')]
  for (const row of rows) {
    lines.push(header.map((col) => toCsvField(row[col])).join(','))
  }
  return lines.join('\n') + '\n'
}
