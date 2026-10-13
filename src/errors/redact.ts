const URI_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:)([^@/\s]+)(@)/gi
const KEYWORD_PASSWORD = /(\bpassword\s*=\s*)([^;\s'"]+)/gi

/**
 * Mask credentials that may appear inside connection strings in free text.
 * Used on every error message/detail/hint and in logs so passwords never leak
 * (spec §9.4, §10.4).
 */
export function redactSecrets(text: string): string {
  return text.replace(URI_PASSWORD, '$1****$3').replace(KEYWORD_PASSWORD, '$1****')
}

/** Redact a connection string for display, keeping the scheme/host/database. */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    if (url.password) url.password = '****'
    return url.toString()
  } catch {
    return connectionString.replace(URI_PASSWORD, '$1****$3')
  }
}
