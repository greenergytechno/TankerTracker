-- Fuel, distance and mileage.
--
-- One log holds two kinds of entry: a plain odometer reading taken every few
-- days, and a refill which also carries litres and rate. Distance comes from
-- the odometer; consumption only from refills.
--
-- Mileage is measured tank to tank. Between two full-tank fills, the litres
-- added after the opening fill up to and including the closing one are exactly
-- the fuel burned over that distance. Part fills carry into the next full span
-- rather than producing a reading of their own.

BEGIN;

CREATE TYPE fuel_entry_kind AS ENUM ('reading', 'refill');

CREATE SEQUENCE fuel_ref_seq START WITH 2001;

CREATE TABLE fuel_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_ref      text NOT NULL UNIQUE DEFAULT ('FL-' || nextval('fuel_ref_seq')),
  vehicle_id     uuid NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  kind           fuel_entry_kind NOT NULL,
  recorded_on    date NOT NULL,
  odometer_km    integer NOT NULL CHECK (odometer_km >= 0),

  -- Refill-only columns.
  litres         numeric(8, 2) CHECK (litres > 0),
  rate_minor     bigint CHECK (rate_minor > 0),          -- paise per litre
  is_full_tank   boolean,
  station        text,
  trip_id        uuid REFERENCES trips (id) ON DELETE SET NULL,

  cost_minor     bigint GENERATED ALWAYS AS
                   (round(litres * rate_minor)::bigint) STORED,

  logged_by      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- A refill carries fuel detail; a bare reading must not.
  CONSTRAINT fuel_refill_has_detail CHECK (
    (kind = 'refill' AND litres IS NOT NULL AND rate_minor IS NOT NULL
                     AND is_full_tank IS NOT NULL)
    OR
    (kind = 'reading' AND litres IS NULL AND rate_minor IS NULL
                      AND is_full_tank IS NULL AND station IS NULL)
  ),

  -- Two entries for one truck at one odometer reading is a double entry.
  CONSTRAINT fuel_no_duplicate_odometer UNIQUE (vehicle_id, odometer_km, kind)
);

CREATE INDEX fuel_log_vehicle_odo_idx ON fuel_log (vehicle_id, odometer_km);
CREATE INDEX fuel_log_vehicle_date_idx ON fuel_log (vehicle_id, recorded_on DESC);
CREATE INDEX fuel_log_refill_idx ON fuel_log (vehicle_id, odometer_km)
  WHERE kind = 'refill';

-- Trip odometers and fuel-log readings describe the same physical dial, so the
-- highest reading on file has to consider both. Without this, a driver could
-- close a trip at a reading below one the fuel clerk already recorded, and the
-- two subsystems would disagree about how far the truck has gone.
--
-- Scoped by date so a legitimately back-dated entry is compared only against
-- readings from on or before its own date.
CREATE FUNCTION vehicle_last_odometer(
  p_vehicle       uuid,
  p_on_or_before  date DEFAULT NULL,
  p_exclude_fuel  uuid DEFAULT NULL,
  p_exclude_trip  uuid DEFAULT NULL
) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT max(x.km)
    FROM (
      SELECT odometer_km AS km, recorded_on AS on_date
        FROM fuel_log
       WHERE vehicle_id = p_vehicle
         AND (p_exclude_fuel IS NULL OR id <> p_exclude_fuel)
      UNION ALL
      SELECT opening_odometer_km, departure_at::date
        FROM trips
       WHERE vehicle_id = p_vehicle AND opening_odometer_km IS NOT NULL
         AND (p_exclude_trip IS NULL OR id <> p_exclude_trip)
      UNION ALL
      SELECT closing_odometer_km, arrival_at::date
        FROM trips
       WHERE vehicle_id = p_vehicle AND closing_odometer_km IS NOT NULL
         AND (p_exclude_trip IS NULL OR id <> p_exclude_trip)
    ) x
   WHERE p_on_or_before IS NULL OR x.on_date <= p_on_or_before;
$$;

-- An odometer only counts up. A reading below the last one for that vehicle is
-- a typo or a swapped truck, and accepting it silently corrupts every mileage
-- figure computed afterwards.
CREATE FUNCTION check_odometer_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last integer;
BEGIN
  v_last := vehicle_last_odometer(NEW.vehicle_id, NEW.recorded_on, NEW.id, NULL);
  IF v_last IS NOT NULL AND NEW.odometer_km < v_last THEN
    RAISE EXCEPTION 'odometer went backwards: % km is below the last recorded % km',
      NEW.odometer_km, v_last
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fuel_log_odometer_monotonic
  BEFORE INSERT OR UPDATE OF odometer_km ON fuel_log
  FOR EACH ROW EXECUTE FUNCTION check_odometer_monotonic();

-- The same rule applied from the trip side.
CREATE FUNCTION check_trip_odometer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last integer;
BEGIN
  IF NEW.opening_odometer_km IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.opening_odometer_km IS DISTINCT FROM NEW.opening_odometer_km)
  THEN
    v_last := vehicle_last_odometer(NEW.vehicle_id, NEW.departure_at::date, NULL, NEW.id);
    IF v_last IS NOT NULL AND NEW.opening_odometer_km < v_last THEN
      RAISE EXCEPTION 'opening odometer % km is below the last recorded % km for this vehicle',
        NEW.opening_odometer_km, v_last
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trips_odometer_sane
  BEFORE INSERT OR UPDATE OF opening_odometer_km, closing_odometer_km ON trips
  FOR EACH ROW EXECUTE FUNCTION check_trip_odometer();

-- ------------------------------------------------------- mileage spans ----
-- Each row is one full-tank-to-full-tank span: the distance covered and the
-- litres it took. Part fills between the two full tanks are folded in by the
-- sum, which is what makes them safe to record.

CREATE VIEW fuel_mileage_spans AS
WITH refills AS (
  SELECT vehicle_id, odometer_km, litres, recorded_on, is_full_tank
    FROM fuel_log
   WHERE kind = 'refill'
),
full_tanks AS (
  -- WHERE is applied before window functions, so this lag steps from one full
  -- tank to the previous full tank, skipping any part fills between them.
  SELECT vehicle_id, odometer_km, recorded_on,
         lag(odometer_km) OVER (PARTITION BY vehicle_id ORDER BY odometer_km)
           AS prev_full_km
    FROM refills
   WHERE is_full_tank
)
SELECT
  f.vehicle_id,
  f.prev_full_km                        AS opened_at_km,
  f.odometer_km                         AS closed_at_km,
  f.odometer_km - f.prev_full_km        AS distance_km,
  -- Everything added after the opening fill, up to and including this one.
  -- Part fills in between are folded in by this sum.
  (SELECT sum(r.litres)
     FROM refills r
    WHERE r.vehicle_id = f.vehicle_id
      AND r.odometer_km > f.prev_full_km
      AND r.odometer_km <= f.odometer_km) AS litres_used,
  f.recorded_on                         AS closed_on
  FROM full_tanks f
 WHERE f.prev_full_km IS NOT NULL
   AND f.odometer_km > f.prev_full_km;

COMMENT ON VIEW fuel_mileage_spans IS
  'One row per completed full-tank-to-full-tank span. Incomplete spans (the '
  'fuel bought since the last full tank) are excluded by the HAVING clause.';

COMMIT;
