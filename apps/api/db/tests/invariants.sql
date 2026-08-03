-- TankerTrack — schema invariant tests
--
-- Each block performs an operation that MUST be rejected by the database.
-- If the operation succeeds, the script aborts with a FAIL. Run against a
-- scratch database only:
--   psql -d tankertrack_test -v ON_ERROR_STOP=1 -f db/tests/invariants.sql

\set ON_ERROR_STOP on
SET client_min_messages = notice;

BEGIN;

-- ------------------------------------------------------------- fixtures ----

-- Fixture identifiers are deliberately test-only so the suite runs against a
-- database that already holds the seeded depot and vehicle roster.
INSERT INTO depots (id, code, name)
VALUES ('11111111-1111-1111-1111-111111111111', 'TEST-DEPOT', 'Test Depot');

INSERT INTO users (id, email, password_hash, full_name, role, depot_id,
                   licence_no, hazmat_endorsed)
VALUES
  ('22222222-2222-2222-2222-222222222222', 'naik@example.com', 'x', 'R. Naik',
   'driver', '11111111-1111-1111-1111-111111111111', 'KA05-2019-0099', true),
  ('33333333-3333-3333-3333-333333333333', 'dispatch@example.com', 'x', 'S. Rao',
   'dispatcher', '11111111-1111-1111-1111-111111111111', NULL, false),
  ('44444444-4444-4444-4444-444444444444', 'iqbal@example.com', 'x', 'M. Iqbal',
   'driver', '11111111-1111-1111-1111-111111111111', 'KA01-2020-0142', true);

INSERT INTO vehicles (id, registration_no, depot_id, capacity_kl, tare_weight_kg)
VALUES ('55555555-5555-5555-5555-555555555555', 'TEST-VEH-0001',
        '11111111-1111-1111-1111-111111111111', 20.00, 9000);

-- ------------------------------------------------- 1. driver needs hazmat ----

DO $$
BEGIN
  BEGIN
    INSERT INTO users (email, password_hash, full_name, role, depot_id, hazmat_endorsed)
    VALUES ('nolicence@example.com', 'x', 'No Licence', 'driver',
            '11111111-1111-1111-1111-111111111111', false);
    RAISE EXCEPTION 'FAIL 1: driver without hazmat endorsement was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 1: driver without hazmat endorsement rejected';
  END;
END;
$$;

-- ------------------------------------------- 2. load must fit the vehicle ----

DO $$
BEGIN
  BEGIN
    INSERT INTO trips (vehicle_id, driver_id, dispatcher_id, depot_id,
                       origin, destination, max_stops, load_kl, deadline_at)
    VALUES ('55555555-5555-5555-5555-555555555555',
            '22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333',
            '11111111-1111-1111-1111-111111111111',
            'Belagavi', 'Hubballi', 2, 25.00, now() + interval '6 hours');
    RAISE EXCEPTION 'FAIL 2: overloaded trip was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 2: load exceeding vehicle capacity rejected';
  END;
END;
$$;

-- --------------------------------------- 3. origin and destination differ ----

DO $$
BEGIN
  BEGIN
    INSERT INTO trips (vehicle_id, driver_id, dispatcher_id, depot_id,
                       origin, destination, max_stops, load_kl, deadline_at)
    VALUES ('55555555-5555-5555-5555-555555555555',
            '22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333',
            '11111111-1111-1111-1111-111111111111',
            'Belagavi', 'Belagavi', 2, 18.20, now() + interval '6 hours');
    RAISE EXCEPTION 'FAIL 3: circular trip was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 3: identical origin and destination rejected';
  END;
END;
$$;

-- the trip everything below hangs off
INSERT INTO trips (id, vehicle_id, driver_id, dispatcher_id, depot_id,
                   origin, destination, max_stops, load_kl, deadline_at)
VALUES ('66666666-6666-6666-6666-666666666666',
        '55555555-5555-5555-5555-555555555555',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
        'Belagavi', 'Hubballi', 2, 18.20, now() + interval '6 hours');

-- --------------------------------- 4. one open trip per vehicle / driver ----

DO $$
BEGIN
  BEGIN
    INSERT INTO trips (vehicle_id, driver_id, dispatcher_id, depot_id,
                       origin, destination, max_stops, load_kl, deadline_at)
    VALUES ('55555555-5555-5555-5555-555555555555',
            '44444444-4444-4444-4444-444444444444',
            '33333333-3333-3333-3333-333333333333',
            '11111111-1111-1111-1111-111111111111',
            'Belagavi', 'Dharwad', 1, 10.00, now() + interval '4 hours');
    RAISE EXCEPTION 'FAIL 4: second open trip on the same vehicle was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 4: second open trip on a busy vehicle rejected';
  END;
END;
$$;

-- ------------------------------- 5. stops rejected on a non-active trip ----

DO $$
BEGIN
  BEGIN
    INSERT INTO trip_stops (trip_id, location_label, stop_type, occurred_at, logged_by)
    VALUES ('66666666-6666-6666-6666-666666666666', 'Dharwad', 'scheduled',
            now(), '22222222-2222-2222-2222-222222222222');
    RAISE EXCEPTION 'FAIL 5: stop logged against a scheduled (not departed) trip';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 5: stop on a not-yet-departed trip rejected';
  END;
END;
$$;

-- --------------------------- 5b. departing needs an opening odometer ----

DO $$
BEGIN
  BEGIN
    UPDATE trips
       SET status = 'active',
           departure_at = now() - interval '4 hours',
           departure_weight_kg = 14360
     WHERE id = '66666666-6666-6666-6666-666666666666';
    RAISE EXCEPTION 'FAIL 5b: trip went active without an opening odometer';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 5b: departure without an opening odometer rejected';
  END;
END;
$$;

-- depart the trip, properly this time
UPDATE trips
   SET status = 'active',
       departure_at = now() - interval '4 hours',
       departure_weight_kg = 14360,
       opening_odometer_km = 142880
 WHERE id = '66666666-6666-6666-6666-666666666666';

-- ------------------------------------ 6. stop cannot predate departure ----

DO $$
BEGIN
  BEGIN
    INSERT INTO trip_stops (trip_id, location_label, stop_type, occurred_at, logged_by)
    VALUES ('66666666-6666-6666-6666-666666666666', 'Impossible', 'scheduled',
            now() - interval '9 hours', '22222222-2222-2222-2222-222222222222');
    RAISE EXCEPTION 'FAIL 6: stop predating departure was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 6: stop predating departure rejected';
  END;
END;
$$;

-- ------------------------- 7. authorisation decided server-side, not client ----
-- Note the deliberately dishonest is_unauthorised => false on the third stop.

INSERT INTO trip_stops (trip_id, location_label, stop_type, occurred_at, logged_by)
VALUES ('66666666-6666-6666-6666-666666666666', 'Dharwad weighbridge', 'scheduled',
        now() - interval '3 hours', '22222222-2222-2222-2222-222222222222');

INSERT INTO trip_stops (trip_id, location_label, stop_type, occurred_at, logged_by)
VALUES ('66666666-6666-6666-6666-666666666666', 'NH-4 fuel bay', 'fuel',
        now() - interval '2 hours', '22222222-2222-2222-2222-222222222222');

INSERT INTO trip_stops (trip_id, location_label, stop_type, occurred_at, logged_by,
                        is_unauthorised, unauthorised_reasons)
VALUES ('66666666-6666-6666-6666-666666666666', 'Unmarked layby', 'unscheduled',
        now() - interval '1 hour', '22222222-2222-2222-2222-222222222222',
        false, '{}');

DO $$
DECLARE
  r record;
BEGIN
  SELECT seq, is_unauthorised, unauthorised_reasons INTO r
    FROM trip_stops
   WHERE trip_id = '66666666-6666-6666-6666-666666666666' AND seq = 3;

  IF NOT r.is_unauthorised THEN
    RAISE EXCEPTION 'FAIL 7: client suppressed the unauthorised flag';
  END IF;
  IF cardinality(r.unauthorised_reasons) <> 2 THEN
    RAISE EXCEPTION 'FAIL 7: expected 2 reasons, got %', r.unauthorised_reasons;
  END IF;
  RAISE NOTICE 'PASS 7: client-supplied flag overridden, reasons = %', r.unauthorised_reasons;
END;
$$;

-- ----------------------------------------- 8. trip_stops are append-only ----

DO $$
BEGIN
  BEGIN
    UPDATE trip_stops SET stop_type = 'break'
     WHERE trip_id = '66666666-6666-6666-6666-666666666666' AND seq = 3;
    RAISE EXCEPTION 'FAIL 8: a logged stop was edited';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 8: editing a logged stop rejected';
  END;
END;
$$;

-- --------------------------------------- 9. ethanol cannot be gained ----

DO $$
BEGIN
  BEGIN
    UPDATE trips
       SET status = 'completed', arrival_at = now(), arrival_weight_kg = 15000,
           closing_odometer_km = 143262
     WHERE id = '66666666-6666-6666-6666-666666666666';
    RAISE EXCEPTION 'FAIL 9: arrival heavier than departure was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 9: arrival weight exceeding departure weight rejected';
  END;
END;
$$;

-- ------------------------ 9b. closing needs an odometer that advanced ----

DO $$
BEGIN
  BEGIN
    UPDATE trips
       SET status = 'completed', arrival_at = now(), arrival_weight_kg = 200
     WHERE id = '66666666-6666-6666-6666-666666666666';
    RAISE EXCEPTION 'FAIL 9b: trip completed without a closing odometer';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 9b: completion without a closing odometer rejected';
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE trips
       SET status = 'completed', arrival_at = now(), arrival_weight_kg = 200,
           closing_odometer_km = 142000
     WHERE id = '66666666-6666-6666-6666-666666666666';
    RAISE EXCEPTION 'FAIL 9c: closing odometer below the opening reading was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 9c: closing odometer below the opening reading rejected';
  END;
END;
$$;

UPDATE trips
   SET status = 'completed', arrival_at = now(), arrival_weight_kg = 200,
       closing_odometer_km = 143262
 WHERE id = '66666666-6666-6666-6666-666666666666';

-- ------------- 9d. trip and fuel-log odometers stay consistent ----

DO $$
BEGIN
  BEGIN
    INSERT INTO fuel_log (vehicle_id, kind, recorded_on, odometer_km, logged_by)
    VALUES ('55555555-5555-5555-5555-555555555555', 'reading', CURRENT_DATE, 100000,
            '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'FAIL 9d: fuel reading below the trip closing odometer accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 9d: fuel reading contradicting a trip odometer rejected';
  END;
END;
$$;

-- ------------------------------------------- 10. no bill, no record ----

DO $$
BEGIN
  BEGIN
    INSERT INTO maintenance_records (vehicle_id, category, description, vendor_name,
                                     invoice_no, serviced_on, amount_minor,
                                     payment_status, created_by)
    VALUES ('55555555-5555-5555-5555-555555555555', 'tyres_wheels',
            'Four rear tyres', 'MRF Tyre Centre', 'MRF/1', CURRENT_DATE,
            9600000, 'paid', '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'FAIL 10: maintenance record accepted without a bill';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE 'PASS 10: maintenance record without an attached bill rejected';
  END;
END;
$$;

INSERT INTO maintenance_bills (id, object_key, original_filename, content_type,
                               size_bytes, checksum_sha256, uploaded_by)
VALUES ('77777777-7777-7777-7777-777777777777', 'bills/2026/mrf-1.pdf',
        'mrf-1.pdf', 'application/pdf', 20480,
        repeat('a', 64), '33333333-3333-3333-3333-333333333333');

INSERT INTO maintenance_records (id, vehicle_id, category, description, vendor_name,
                                 invoice_no, serviced_on, amount_minor, gst_bps,
                                 payment_status, bill_id, created_by)
VALUES ('88888888-8888-8888-8888-888888888888',
        '55555555-5555-5555-5555-555555555555', 'tyres_wheels',
        'Four rear tyres replaced', 'MRF Tyre Centre', 'MRF/DWD/8842',
        CURRENT_DATE - 10, 9600000, 1800, 'paid',
        '77777777-7777-7777-7777-777777777777',
        '33333333-3333-3333-3333-333333333333');

-- ------------------------------------------ 11. GST total is computed ----

DO $$
DECLARE
  v_total bigint;
BEGIN
  SELECT total_minor INTO v_total FROM maintenance_records
   WHERE id = '88888888-8888-8888-8888-888888888888';
  IF v_total <> 11328000 THEN
    RAISE EXCEPTION 'FAIL 11: expected total 11328000 paise, got %', v_total;
  END IF;
  RAISE NOTICE 'PASS 11: 96000.00 + 18%% GST = % paise', v_total;
END;
$$;

-- ------------------------------------- 12. one bill, one record ----

DO $$
BEGIN
  BEGIN
    INSERT INTO maintenance_records (vehicle_id, category, description, vendor_name,
                                     invoice_no, serviced_on, amount_minor,
                                     payment_status, bill_id, created_by)
    VALUES ('55555555-5555-5555-5555-555555555555', 'brakes_suspension',
            'Reusing someone else''s bill', 'Sri Balaji Motors', 'SBM/9',
            CURRENT_DATE, 100000, 'unpaid',
            '77777777-7777-7777-7777-777777777777',
            '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'FAIL 12: the same bill backed two records';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 12: reusing one bill for a second record rejected';
  END;
END;
$$;

-- ------------------------------ 13. duplicate invoice per vendor ----

DO $$
BEGIN
  BEGIN
    INSERT INTO maintenance_bills (id, object_key, original_filename, content_type,
                                   size_bytes, checksum_sha256, uploaded_by)
    VALUES ('99999999-9999-9999-9999-999999999999', 'bills/2026/dupe.pdf',
            'dupe.pdf', 'application/pdf', 1024, repeat('b', 64),
            '33333333-3333-3333-3333-333333333333');

    INSERT INTO maintenance_records (vehicle_id, category, description, vendor_name,
                                     invoice_no, serviced_on, amount_minor,
                                     payment_status, bill_id, created_by)
    VALUES ('55555555-5555-5555-5555-555555555555', 'tyres_wheels',
            'Same invoice again', 'MRF Tyre Centre', 'MRF/DWD/8842',
            CURRENT_DATE, 9600000, 'paid',
            '99999999-9999-9999-9999-999999999999',
            '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'FAIL 13: duplicate vendor invoice was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 13: duplicate invoice for the same vendor rejected';
  END;
END;
$$;

-- ---------------------------------- 14. future service date rejected ----

DO $$
BEGIN
  BEGIN
    INSERT INTO maintenance_bills (id, object_key, original_filename, content_type,
                                   size_bytes, checksum_sha256, uploaded_by)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bills/2026/future.pdf',
            'future.pdf', 'application/pdf', 1024, repeat('c', 64),
            '33333333-3333-3333-3333-333333333333');

    INSERT INTO maintenance_records (vehicle_id, category, description, vendor_name,
                                     invoice_no, serviced_on, amount_minor,
                                     payment_status, bill_id, created_by)
    VALUES ('55555555-5555-5555-5555-555555555555', 'insurance',
            'Next year already', 'New India Assurance', 'NIA/1',
            CURRENT_DATE + 30, 100000, 'unpaid',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'FAIL 14: future-dated service was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 14: future-dated service record rejected';
  END;
END;
$$;

-- ------------------------------------- 15. rejected content type ----

DO $$
BEGIN
  BEGIN
    INSERT INTO maintenance_bills (object_key, original_filename, content_type,
                                   size_bytes, checksum_sha256, uploaded_by)
    VALUES ('bills/2026/evil.exe', 'evil.exe', 'application/x-msdownload',
            1024, repeat('d', 64), '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'FAIL 15: executable accepted as a bill';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 15: non-document bill upload rejected';
  END;
END;
$$;

-- ------------------------------------------ 16. audit log immutable ----

INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id)
VALUES ('33333333-3333-3333-3333-333333333333', 'dispatcher',
        'trip.schedule', 'trip', '66666666-6666-6666-6666-666666666666');

DO $$
BEGIN
  BEGIN
    DELETE FROM audit_log WHERE entity_type = 'trip';
    RAISE EXCEPTION 'FAIL 16: audit history was deleted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 16: deleting audit history rejected';
  END;
END;
$$;

-- ------------------------------------------------- report arithmetic ----

DO $$
DECLARE
  v_delivered numeric;
  v_flagged   integer;
BEGIN
  SELECT departure_weight_kg - arrival_weight_kg INTO v_delivered
    FROM trips WHERE id = '66666666-6666-6666-6666-666666666666';
  SELECT count(*) INTO v_flagged
    FROM trip_stops
   WHERE trip_id = '66666666-6666-6666-6666-666666666666' AND is_unauthorised;

  RAISE NOTICE 'REPORT: delivered % kg, % unauthorised stop(s)', v_delivered, v_flagged;
END;
$$;

ROLLBACK;
