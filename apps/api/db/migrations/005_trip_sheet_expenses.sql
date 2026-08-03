-- Trip sheet: financial settlement and driver expenses.
--
-- Standardises the paper "DISPATCH VEHICLE TRIP SHEET". The manager fixes the
-- settlement inputs at scheduling (advance, invoice, expected return); the
-- driver may only add expense lines against them. That split is enforced here:
-- the manager's columns live on `trips`, the driver's live in `trip_expenses`,
-- and the API grants each role write access only to its own.

BEGIN;

-- ------------------------------------------- manager-set trip sheet fields ----

ALTER TABLE trips
  ADD COLUMN invoice_no        text,
  ADD COLUMN driver_phone      text,
  ADD COLUMN advance_minor     bigint NOT NULL DEFAULT 0 CHECK (advance_minor >= 0),
  ADD COLUMN expected_return_on date,
  -- Diesel the driver logs at close, for this trip's mileage. Litres, not cash;
  -- diesel is settled on the fuel card, not out of the advance.
  ADD COLUMN diesel_litres     numeric(8, 2) CHECK (diesel_litres > 0);

-- Total distance, computed once both odometer readings are in.
ALTER TABLE trips
  ADD COLUMN distance_km integer
    GENERATED ALWAYS AS (closing_odometer_km - opening_odometer_km) STORED;

-- ------------------------------------------------- driver expense lines ----

CREATE SEQUENCE trip_expense_ref_seq START WITH 1;

CREATE TABLE trip_expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_ref   text NOT NULL UNIQUE DEFAULT ('EX-' || nextval('trip_expense_ref_seq')),
  trip_id       uuid NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  -- Free text rather than an enum: the standard four heads (Food, Parking,
  -- Unloading, RTO Charges) are a UI convention, but the driver can name a
  -- one-off (Toll, Fine, Green tax) and the sheet must not reject it.
  head          text NOT NULL CHECK (length(btrim(head)) > 0),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  note          text,
  -- Receipt is optional here, unlike a maintenance bill: a driver may pay cash
  -- with no slip. When present it is a stored object, same as any other bill.
  bill_id       uuid REFERENCES maintenance_bills (id) ON DELETE SET NULL,
  logged_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trip_expenses_trip_idx ON trip_expenses (trip_id);

-- Expenses are the driver's record of what they spent; correcting one is a new
-- line plus a reversal, not a silent edit. Append-only, like trip_stops.
CREATE FUNCTION trip_expenses_no_edit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trip_expenses is append-only; add a correcting line instead'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER trip_expenses_append_only
  BEFORE UPDATE OR DELETE ON trip_expenses
  FOR EACH ROW EXECUTE FUNCTION trip_expenses_no_edit();

-- ------------------------------------------------- settlement view ----
-- One row per trip: total expenses, advance, and the balance. Positive balance
-- is owed to the driver; negative is recoverable from them.

CREATE VIEW trip_settlement AS
SELECT
  t.id AS trip_id,
  t.trip_ref,
  t.advance_minor,
  coalesce(e.total_minor, 0)                       AS expenses_minor,
  coalesce(e.total_minor, 0) - t.advance_minor     AS balance_minor,
  t.distance_km,
  t.diesel_litres,
  CASE WHEN t.diesel_litres > 0
       THEN round(t.distance_km / t.diesel_litres, 2)
  END                                              AS mileage_kmpl
  FROM trips t
  LEFT JOIN (
    SELECT trip_id, sum(amount_minor) AS total_minor
      FROM trip_expenses GROUP BY trip_id
  ) e ON e.trip_id = t.id;

-- The new table follows the same least-privilege grants as the rest.
GRANT SELECT, INSERT ON trip_expenses TO tankertrack_app;
GRANT SELECT ON trip_settlement TO tankertrack_app;
GRANT USAGE, SELECT ON SEQUENCE trip_expense_ref_seq TO tankertrack_app;
REVOKE UPDATE, DELETE ON trip_expenses FROM tankertrack_app;

COMMIT;
