-- Reference data: depots and the 15-vehicle roster.
--
-- The registrations below are the placeholders carried over from the HTML
-- prototype. Replace them with the real roster before this reaches a depot —
-- vehicle identity is what every trip and every bill hangs off.
--
-- Contains no users: accounts are created through the API so passwords are
-- hashed rather than sitting in a migration file in version control.

BEGIN;

INSERT INTO depots (code, name, address, latitude, longitude) VALUES
  ('BGM', 'Belagavi Depot', 'Belagavi, Karnataka', 15.852000, 74.498600),
  ('BLR', 'Bengaluru Depot', 'Bengaluru, Karnataka', 12.971600, 77.594600)
ON CONFLICT (code) DO NOTHING;

INSERT INTO vehicles (registration_no, depot_id, capacity_kl, tare_weight_kg, status)
SELECT v.reg, d.id, v.capacity, v.tare, v.status::vehicle_status
  FROM (VALUES
    ('KA-05-AB-4471', 'BGM', 20.00, 9000, 'available'),
    ('KA-01-CT-9012', 'BLR', 20.00, 9050, 'available'),
    ('KA-03-EF-2210', 'BLR', 18.00, 8800, 'available'),
    ('KA-09-GH-6634', 'BGM', 20.00, 9100, 'available'),
    ('KA-02-MN-1187', 'BLR', 20.00, 9000, 'available'),
    ('KA-07-XY-3345', 'BGM', 18.00, 8750, 'maintenance'),
    ('KA-04-JK-7729', 'BGM', 20.00, 9000, 'available'),
    ('KA-08-PQ-5561', 'BLR', 16.00, 8400, 'available'),
    ('KA-06-RS-8823', 'BGM', 20.00, 9050, 'available'),
    ('KA-10-TU-4409', 'BLR', 20.00, 9000, 'available'),
    ('KA-11-VW-6672', 'BGM', 18.00, 8800, 'available'),
    ('KA-12-DE-3318', 'BLR', 20.00, 9100, 'available'),
    ('KA-13-FG-9945', 'BGM', 20.00, 9000, 'available'),
    ('KA-14-HI-2276', 'BLR', 16.00, 8400, 'available'),
    ('KA-15-LM-5530', 'BGM', 20.00, 9050, 'available')
  ) AS v(reg, depot_code, capacity, tare, status)
  JOIN depots d ON d.code = v.depot_code
ON CONFLICT (registration_no) DO NOTHING;

COMMIT;
