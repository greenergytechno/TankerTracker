-- TankerTrack — core schema
-- Target: PostgreSQL 14+ (developed against 18). No PostGIS dependency; see
-- 003_optional_postgis.sql for the geospatial upgrade used by the GPS phase.
--
-- Design notes that are not obvious from the DDL:
--   * Money is stored as bigint minor units (paise). Never float.
--   * GST is stored in basis points (1800 = 18.00%) so rates stay exact.
--   * Rules the driver's device must not be able to suppress — stop
--     authorisation, trip-state legality, "no bill, no record" — are enforced
--     here as constraints and triggers, not in application code.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- enums ----

CREATE TYPE user_role AS ENUM ('driver', 'dispatcher', 'fleet_manager', 'admin');
CREATE TYPE vehicle_status AS ENUM ('available', 'on_trip', 'maintenance', 'retired');
CREATE TYPE trip_status AS ENUM ('scheduled', 'active', 'completed', 'cancelled');
CREATE TYPE stop_type AS ENUM ('scheduled', 'fuel', 'break', 'unscheduled');
CREATE TYPE payment_status AS ENUM ('paid', 'unpaid', 'part_paid');

CREATE TYPE maintenance_category AS ENUM (
  'preventive_service', 'engine_transmission', 'tyres_wheels', 'brakes_suspension',
  'electrical_battery', 'body_cabin', 'tanker_barrel_manhole', 'valves_hoses_seals',
  'pump_metering_unit', 'safety_equipment_hazmat', 'tank_calibration_certification',
  'statutory_fc_puc_permit', 'insurance', 'breakdown_roadside', 'accident_repair'
);

-- ------------------------------------------------------------ utilities ----

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- depots ----

CREATE TABLE depots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  address     text,
  latitude    numeric(9, 6),
  longitude   numeric(9, 6),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT depot_latlng_paired CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT depot_lat_range CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CONSTRAINT depot_lng_range CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

CREATE TRIGGER depots_updated_at BEFORE UPDATE ON depots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------- users ----

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  role           user_role NOT NULL,
  depot_id       uuid REFERENCES depots (id) ON DELETE RESTRICT,
  phone          text,
  licence_no     text,
  licence_expiry date,
  hazmat_endorsed boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Dispatchers are scoped to their depot's fleet; drivers to their own trips.
  -- Only admins and fleet managers may be depot-less (fleet-wide).
  CONSTRAINT depot_required_for_scoped_roles
    CHECK (role IN ('fleet_manager', 'admin') OR depot_id IS NOT NULL),
  -- A driver hauling ethanol must hold a current hazmat endorsement.
  CONSTRAINT driver_needs_hazmat_licence
    CHECK (role <> 'driver' OR (hazmat_endorsed AND licence_no IS NOT NULL))
);

CREATE INDEX users_role_depot_idx ON users (role, depot_id) WHERE is_active;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------- device sessions ----
-- Device binding per driver login, with remote revocation for a lost phone.

CREATE TABLE device_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_fingerprint  text NOT NULL,
  device_label        text,
  refresh_token_hash  text NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES users (id),
  CONSTRAINT session_expiry_after_issue CHECK (expires_at > issued_at)
);

-- One live session per device per user; revoked rows are exempt so history keeps.
CREATE UNIQUE INDEX device_sessions_live_idx
  ON device_sessions (user_id, device_fingerprint)
  WHERE revoked_at IS NULL;

CREATE INDEX device_sessions_user_idx ON device_sessions (user_id);

-- -------------------------------------------------------------- vehicles ----

CREATE TABLE vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_no text NOT NULL UNIQUE,
  depot_id        uuid NOT NULL REFERENCES depots (id) ON DELETE RESTRICT,
  make_model      text,
  capacity_kl     numeric(6, 2) NOT NULL CHECK (capacity_kl > 0),
  tare_weight_kg  integer CHECK (tare_weight_kg > 0),
  status          vehicle_status NOT NULL DEFAULT 'available',
  fc_expiry       date,
  puc_expiry      date,
  insurance_expiry date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vehicles_depot_idx ON vehicles (depot_id, status);

CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------- trips ----

CREATE SEQUENCE trip_ref_seq START WITH 4821;

CREATE TABLE trips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_ref            text NOT NULL UNIQUE DEFAULT ('TS-' || nextval('trip_ref_seq')),
  vehicle_id          uuid NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  driver_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  dispatcher_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  depot_id            uuid NOT NULL REFERENCES depots (id) ON DELETE RESTRICT,

  origin              text NOT NULL,
  destination         text NOT NULL,
  max_stops           integer NOT NULL CHECK (max_stops >= 0),
  load_kl             numeric(6, 2) NOT NULL CHECK (load_kl > 0),
  deadline_at         timestamptz NOT NULL,
  gps_access_point    text,
  -- Per-trip so the flat 45 minutes can be relaxed for long highway legs,
  -- which is the tuning question left open in the project brief.
  inactivity_threshold_minutes integer NOT NULL DEFAULT 45
    CHECK (inactivity_threshold_minutes > 0),

  status              trip_status NOT NULL DEFAULT 'scheduled',
  departure_at        timestamptz,
  departure_weight_kg numeric(10, 2) CHECK (departure_weight_kg > 0),
  opening_odometer_km integer CHECK (opening_odometer_km >= 0),
  arrival_at          timestamptz,
  arrival_weight_kg   numeric(10, 2) CHECK (arrival_weight_kg >= 0),
  closing_odometer_km integer CHECK (closing_odometer_km >= 0),
  cancelled_reason    text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_endpoints_differ CHECK (origin <> destination),
  CONSTRAINT trip_arrival_after_departure
    CHECK (arrival_at IS NULL OR departure_at IS NULL OR arrival_at > departure_at),
  -- Ethanol cannot be gained in transit; a heavier arrival means a bad weighing.
  CONSTRAINT trip_cannot_gain_weight
    CHECK (arrival_weight_kg IS NULL OR departure_weight_kg IS NULL
           OR arrival_weight_kg <= departure_weight_kg),
  -- A trip cannot go active without the reading on the dash at the depot, and
  -- cannot close without the reading on arrival. Distance is the basis of every
  -- mileage and cost-per-km figure downstream, so it is not optional.
  CONSTRAINT trip_active_needs_departure
    CHECK (status <> 'active' OR (departure_at IS NOT NULL AND departure_weight_kg IS NOT NULL
                                  AND opening_odometer_km IS NOT NULL)),
  CONSTRAINT trip_completed_needs_arrival
    CHECK (status <> 'completed' OR (arrival_at IS NOT NULL AND arrival_weight_kg IS NOT NULL
                                     AND departure_at IS NOT NULL
                                     AND closing_odometer_km IS NOT NULL)),
  CONSTRAINT trip_odometer_advances
    CHECK (closing_odometer_km IS NULL OR opening_odometer_km IS NULL
           OR closing_odometer_km > opening_odometer_km),
  CONSTRAINT trip_cancelled_needs_reason
    CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL)
);

-- A vehicle may hold only one trip that is not yet finished. This is the
-- database-level form of the dispatcher-side "already has an open trip" check.
CREATE UNIQUE INDEX trips_one_open_per_vehicle_idx
  ON trips (vehicle_id)
  WHERE status IN ('scheduled', 'active');

-- Likewise a driver cannot be on two trips at once.
CREATE UNIQUE INDEX trips_one_open_per_driver_idx
  ON trips (driver_id)
  WHERE status IN ('scheduled', 'active');

CREATE INDEX trips_depot_status_idx ON trips (depot_id, status, created_at DESC);
CREATE INDEX trips_driver_idx ON trips (driver_id, created_at DESC);

CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The load put on the truck must fit the truck.
CREATE FUNCTION check_trip_load_fits_vehicle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_capacity numeric(6, 2);
BEGIN
  SELECT capacity_kl INTO v_capacity FROM vehicles WHERE id = NEW.vehicle_id;
  IF NEW.load_kl > v_capacity THEN
    RAISE EXCEPTION 'load of % KL exceeds vehicle capacity of % KL', NEW.load_kl, v_capacity
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trips_load_fits_vehicle
  BEFORE INSERT OR UPDATE OF load_kl, vehicle_id ON trips
  FOR EACH ROW EXECUTE FUNCTION check_trip_load_fits_vehicle();

-- ------------------------------------------------------------ trip stops ----

CREATE TABLE trip_stops (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  location_label text NOT NULL,
  latitude      numeric(9, 6),
  longitude     numeric(9, 6),
  stop_type     stop_type NOT NULL,
  occurred_at   timestamptz NOT NULL,
  odometer_km   integer CHECK (odometer_km >= 0),
  notes         text,
  logged_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  -- Written by trigger only. Any value supplied by the client is discarded.
  is_unauthorised       boolean NOT NULL DEFAULT false,
  unauthorised_reasons  text[] NOT NULL DEFAULT '{}',

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stop_seq_unique UNIQUE (trip_id, seq),
  CONSTRAINT stop_latlng_paired CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX trip_stops_trip_idx ON trip_stops (trip_id, occurred_at);

-- Stop authorisation is decided here so a compromised driver device cannot
-- suppress the flag by lying about it in the request body.
CREATE FUNCTION evaluate_stop_authorisation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_max_stops    integer;
  v_status       trip_status;
  v_departure_at timestamptz;
  v_reasons      text[] := '{}';
BEGIN
  SELECT max_stops, status, departure_at
    INTO v_max_stops, v_status, v_departure_at
    FROM trips WHERE id = NEW.trip_id
    FOR UPDATE;

  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'stops may only be logged against an active trip (trip is %)', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.occurred_at < v_departure_at THEN
    RAISE EXCEPTION 'stop cannot predate departure at %', v_departure_at
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(max(seq), 0) + 1 INTO NEW.seq
    FROM trip_stops WHERE trip_id = NEW.trip_id;

  -- array_append rather than ||: with a bare literal on the right, || resolves
  -- to array-to-array concatenation and fails to parse the string as an array.
  IF NEW.stop_type = 'unscheduled' THEN
    v_reasons := array_append(v_reasons, 'Marked unscheduled / off-route');
  END IF;

  IF NEW.seq > v_max_stops THEN
    v_reasons := array_append(v_reasons, format('Exceeds max-stops limit (%s)', v_max_stops));
  END IF;

  NEW.unauthorised_reasons := v_reasons;
  NEW.is_unauthorised := cardinality(v_reasons) > 0;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trip_stops_authorisation
  BEFORE INSERT ON trip_stops
  FOR EACH ROW EXECUTE FUNCTION evaluate_stop_authorisation();

-- A logged stop is evidence. Correcting one means a new record, not an edit.
CREATE FUNCTION trip_stops_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trip_stops is append-only; log a correcting entry instead'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER trip_stops_no_mutation
  BEFORE UPDATE OR DELETE ON trip_stops
  FOR EACH ROW EXECUTE FUNCTION trip_stops_are_append_only();

-- ----------------------------------------------------- maintenance bills ----
-- The bill row is created by the upload endpoint first. A maintenance record
-- then points at it with a NOT NULL reference, which is what makes
-- "no bill, no record" an invariant of the database rather than a UI rule.

CREATE TABLE maintenance_bills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key        text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  content_type      text NOT NULL,
  size_bytes        bigint NOT NULL CHECK (size_bytes > 0),
  checksum_sha256   char(64) NOT NULL,
  uploaded_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bill_content_type_allowed
    CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT bill_checksum_is_hex CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

-- Catches the same scan being uploaded twice under different filenames.
CREATE UNIQUE INDEX maintenance_bills_checksum_idx ON maintenance_bills (checksum_sha256);

-- --------------------------------------------------- maintenance records ----

CREATE SEQUENCE maintenance_ref_seq START WITH 1001;

CREATE TABLE maintenance_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_ref     text NOT NULL UNIQUE DEFAULT ('MR-' || nextval('maintenance_ref_seq')),
  vehicle_id     uuid NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  category       maintenance_category NOT NULL,
  description    text NOT NULL CHECK (length(btrim(description)) > 0),
  vendor_name    text NOT NULL CHECK (length(btrim(vendor_name)) > 0),
  invoice_no     text NOT NULL CHECK (length(btrim(invoice_no)) > 0),
  serviced_on    date NOT NULL,
  odometer_km    integer CHECK (odometer_km >= 0),

  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  gst_bps        integer NOT NULL DEFAULT 1800 CHECK (gst_bps BETWEEN 0 AND 10000),
  total_minor    bigint GENERATED ALWAYS AS
                   (amount_minor + (amount_minor * gst_bps + 5000) / 10000) STORED,

  payment_status payment_status NOT NULL,
  next_due_on    date,

  -- The reason this column is NOT NULL is the whole point of the table.
  bill_id        uuid NOT NULL UNIQUE REFERENCES maintenance_bills (id) ON DELETE RESTRICT,

  created_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maintenance_invoice_unique_per_vendor UNIQUE (vendor_name, invoice_no),
  CONSTRAINT maintenance_next_due_after_service
    CHECK (next_due_on IS NULL OR next_due_on >= serviced_on)
);

CREATE INDEX maintenance_vehicle_idx ON maintenance_records (vehicle_id, serviced_on DESC);
CREATE INDEX maintenance_category_idx ON maintenance_records (category);
CREATE INDEX maintenance_unpaid_idx ON maintenance_records (payment_status)
  WHERE payment_status <> 'paid';
CREATE INDEX maintenance_next_due_idx ON maintenance_records (next_due_on)
  WHERE next_due_on IS NOT NULL;

CREATE TRIGGER maintenance_updated_at BEFORE UPDATE ON maintenance_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CURRENT_DATE is not immutable so this cannot be a CHECK constraint.
CREATE FUNCTION check_service_date_not_future() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.serviced_on > CURRENT_DATE THEN
    RAISE EXCEPTION 'service date % is in the future', NEW.serviced_on
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER maintenance_service_date_sane
  BEFORE INSERT OR UPDATE OF serviced_on ON maintenance_records
  FOR EACH ROW EXECUTE FUNCTION check_service_date_not_future();

-- ------------------------------------------------------------- audit log ----
-- Append-only trail for hazmat compliance: who logged what, when, from where.

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_role   user_role,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  before_state jsonb,
  after_state  jsonb,
  latitude     numeric(9, 6),
  longitude    numeric(9, 6),
  ip_address   inet,
  user_agent   text
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, occurred_at DESC);

CREATE FUNCTION audit_log_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_immutable();

-- --------------------------------------------------------- least privilege ----
-- The API connects as tankertrack_app, which can read and write rows but
-- cannot alter the schema or rewrite history.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tankertrack_app') THEN
    CREATE ROLE tankertrack_app LOGIN;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO tankertrack_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tankertrack_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tankertrack_app;

-- Belt and braces alongside the triggers above.
REVOKE UPDATE, DELETE ON audit_log FROM tankertrack_app;
REVOKE UPDATE, DELETE ON trip_stops FROM tankertrack_app;

COMMIT;
