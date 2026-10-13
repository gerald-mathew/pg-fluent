import { PgFluentError } from '../errors/index.js'

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
])

const PREFERRED_KEYS = ['geometry', 'geom', 'the_geom']

function isGeometry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return (
    typeof type === 'string' &&
    GEOMETRY_TYPES.has(type) &&
    ('coordinates' in value || 'geometries' in value)
  )
}

function findGeometryKey(row: Record<string, unknown>): string | undefined {
  for (const key of PREFERRED_KEYS) {
    if (isGeometry(row[key])) return key
  }
  for (const [key, value] of Object.entries(row)) {
    if (isGeometry(value)) return key
  }
  return undefined
}

/**
 * Convert a JSON row array into a GeoJSON `FeatureCollection`.
 *
 * The geometry for each row is taken from the first GeoJSON-geometry-valued
 * column (preferring `geometry`/`geom`/`the_geom`); all other columns become
 * `properties`. Because pg-fluent talks to PostgreSQL directly, geometry
 * columns must already be serialized as GeoJSON (e.g. `ST_AsGeoJSON(geom)::json`
 * or a `json`/`jsonb` column); raw PostGIS `geometry` values are WKB and are
 * not converted.
 */
export function toGeoJson(rows: Record<string, unknown>[]): string {
  const features: Array<Record<string, unknown>> = []
  for (const row of rows) {
    const key = findGeometryKey(row)
    if (key === undefined) {
      throw new PgFluentError(
        'PGFLUENT_INVALID_QUERY',
        'GeoJSON output requires a geometry column',
        {
          hint:
            'Select a GeoJSON geometry object (e.g. ST_AsGeoJSON(...)::json) named ' +
            '"geometry", "geom" or "the_geom".',
        }
      )
    }
    const properties: Record<string, unknown> = {}
    for (const [prop, value] of Object.entries(row)) {
      if (prop !== key) properties[prop] = value
    }
    features.push({ type: 'Feature', geometry: row[key], properties })
  }
  return JSON.stringify({ type: 'FeatureCollection', features })
}
