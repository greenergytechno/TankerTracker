-- OPTIONAL — not applied by `npm run migrate`.
--
-- Adds the geospatial layer for the GPS ingestion phase: live positions,
-- geofences, and route paths. Requires the PostGIS extension, which is NOT
-- part of a stock PostgreSQL install. On Windows, add it via EDB Stack Builder
-- (Spatial Extensions → PostGIS) before running this file, then:
--
--   psql -d tankertrack -v ON_ERROR_STOP=1 -f db/migrations/003_optional_postgis.sql
--
-- Until then the core schema stores latitude/longitude as plain numerics, which
-- is sufficient for logged stops and audit positions.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- Depots and stops keep their numeric columns; these are generated companions
-- so existing rows need no backfill and the API can migrate over gradually.
ALTER TABLE depots
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE WHEN latitude IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(longitude::float8, latitude::float8), 4326)::geography
    END
  ) STORED;

ALTER TABLE trip_stops
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE WHEN latitude IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(longitude::float8, latitude::float8), 4326)::geography
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS trip_stops_location_idx ON trip_stops USING GIST (location);

-- Corridors and permitted halt areas. A stop outside every geofence for its
-- trip is the real replacement for the prototype's rule-based flag.
CREATE TABLE IF NOT EXISTS geofences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('route_corridor', 'permitted_halt', 'depot', 'restricted')),
  depot_id    uuid REFERENCES depots (id) ON DELETE CASCADE,
  area        geography(Polygon, 4326) NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geofences_area_idx ON geofences USING GIST (area);

-- Raw telemetry from the trackers. High volume: partition by month before this
-- grows past a few hundred million rows.
CREATE TABLE IF NOT EXISTS gps_pings (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id   uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  trip_id      uuid REFERENCES trips (id) ON DELETE SET NULL,
  recorded_at  timestamptz NOT NULL,
  position     geography(Point, 4326) NOT NULL,
  speed_kph    numeric(5, 1) CHECK (speed_kph >= 0),
  heading_deg  smallint CHECK (heading_deg BETWEEN 0 AND 359),
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  -- The tracker clock cannot be trusted to be monotonic, but it must not be
  -- wildly ahead of ours; a spoofed flood of future pings is rejected here.
  CONSTRAINT ping_not_from_the_future CHECK (recorded_at < ingested_at + interval '5 minutes')
);

CREATE INDEX IF NOT EXISTS gps_pings_vehicle_time_idx ON gps_pings (vehicle_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS gps_pings_position_idx ON gps_pings USING GIST (position);
CREATE UNIQUE INDEX IF NOT EXISTS gps_pings_dedupe_idx ON gps_pings (vehicle_id, recorded_at);

COMMIT;
