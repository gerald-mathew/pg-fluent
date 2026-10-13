import {
  PgFluentError,
  databaseError,
  fromPgFluentError,
  redactSecrets,
  type ClassifiedError,
  type PgDatabaseError,
} from '../errors/index.js'

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  428: 'Precondition Required',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
}

function isClassified(err: unknown): err is ClassifiedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { kind?: unknown }).kind === 'string' &&
    typeof (err as { status?: unknown }).status === 'number'
  )
}

function isPgError(err: unknown): err is PgDatabaseError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    (err as { code: string }).code.length === 5 &&
    /^[0-9A-Z]{5}$/.test((err as { code: string }).code)
  )
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof PgFluentError) return fromPgFluentError(err)
  if (isClassified(err)) return err
  if (isPgError(err)) return databaseError(err)
  if (err instanceof Error) {
    return {
      message: redactSecrets(err.message),
      details: '',
      hint: '',
      code: 'PGFLUENT_INTERNAL',
      kind: 'internal',
      status: 500,
    }
  }
  return {
    message: redactSecrets(String(err)),
    details: '',
    hint: '',
    code: 'PGFLUENT_INTERNAL',
    kind: 'internal',
    status: 500,
  }
}

export function buildErrorResponse(err: unknown): Response {
  const classified = classifyError(err)
  const body = JSON.stringify({
    code: classified.code,
    details: classified.details,
    hint: classified.hint,
    message: classified.message,
  })
  return new Response(body, {
    status: classified.status,
    statusText: STATUS_TEXT[classified.status] ?? 'Error',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
