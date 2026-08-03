# TankerTrack API

NestJS + PostgreSQL backend for the ethanol fleet TMS. The database is a hard
dependency: the process refuses to start if Postgres is unreachable or the
schema has not been migrated.

## Status

The schema is verified — it applies cleanly to PostgreSQL 18 and all 16
invariant tests pass (`db/tests/invariants.sql`). **The TypeScript has never
been compiled or run**, because Node.js is not installed on this machine. Treat
`src/` as reviewed-but-unexecuted until `npm run typecheck` passes.

## Requirements

- Node.js 20+ — **not currently installed**; get it from https://nodejs.org
- PostgreSQL 14+ — installed here at `C:\Program Files\PostgreSQL\18`
- An S3-compatible object store for bill scans (MinIO works locally)
- PostGIS is **optional** and not installed; only migration `003` needs it

## Setup

```bash
cd apps/api
cp .env.example .env          # then fill in the secrets
npm install
```

Create the database and its application role. Run this as a Postgres superuser —
it is the one step that needs your `postgres` password:

```bash
psql -U postgres -c "CREATE DATABASE tankertrack"
```

Then apply the schema:

```bash
npm run migrate            # applies db/migrations/*.sql in order
npm run migrate -- --status
```

Set a password for the role the API logs in as (created by migration 001):

```bash
psql -U postgres -d tankertrack -c "ALTER ROLE tankertrack_app PASSWORD 'a-strong-password'"
```

Put that password in `DATABASE_URL`, then:

```bash
npm run start:dev
```

## Verifying the schema

```bash
psql -d tankertrack_test -v ON_ERROR_STOP=1 -f db/tests/invariants.sql
```

Every block attempts an operation that must be rejected. The script rolls back,
so it is safe to re-run, but point it at a scratch database regardless.

## Why the rules live in the database

The brief requires that unauthorised-stop rules are evaluated server-side so a
compromised handset cannot suppress an alert. Putting them in the service layer
would satisfy that literally, but a bug or a second writer would bypass them.
They are therefore constraints and triggers:

| Rule | Enforced by |
| --- | --- |
| Stop is unauthorised if unscheduled or over the limit | `evaluate_stop_authorisation` trigger — overwrites whatever the client sent |
| A logged stop cannot be edited or deleted | `trip_stops_are_append_only` trigger |
| A vehicle or driver can hold only one open trip | partial unique indexes on `trips` |
| Arrival cannot be heavier than departure | `trip_cannot_gain_weight` check |
| A trip cannot go active without an opening odometer | `trip_active_needs_departure` check |
| A trip cannot complete without a closing odometer that advanced | `trip_completed_needs_arrival` + `trip_odometer_advances` checks |
| Trip and fuel-log odometers cannot contradict each other | `vehicle_last_odometer` + monotonic triggers on both tables |
| Load cannot exceed tanker capacity | `check_trip_load_fits_vehicle` trigger |
| **A maintenance record cannot exist without its bill** | `maintenance_records.bill_id` is `NOT NULL UNIQUE` |
| One bill backs exactly one record | `UNIQUE` on `bill_id` |
| An odometer cannot go backwards | `check_odometer_monotonic` trigger on `fuel_log` |
| A refill carries litres and rate; a bare reading does not | `fuel_refill_has_detail` check |
| Audit history cannot be rewritten | `audit_log_is_immutable` trigger + `REVOKE` |
| A driver must hold a hazmat endorsement | `driver_needs_hazmat_licence` check |

`DatabaseExceptionFilter` maps these violations onto proper HTTP responses, so
a constraint breach reads as a 400 or 409 with a usable message rather than a
500.

## Fuel and mileage

`fuel_log` holds two kinds of entry against one vehicle: a bare odometer
reading taken every few days, and a refill that also carries litres, rate and
whether the tank was filled to full. Distance comes from the odometer;
consumption only from refills.

Mileage is measured tank to tank by the `fuel_mileage_spans` view. Between two
full-tank fills, the litres added after the opening fill up to and including
the closing one are exactly the fuel burned over that distance. Part fills fold
into the next complete span rather than producing a false reading of their own —
verified against a fixture running at exactly 4.00 km/L with a part fill in the
middle, which the view recovers to 4.000.

## Trip sheet & settlement

Migration `005` standardises the paper "DISPATCH VEHICLE TRIP SHEET". The split
the business cares about — manager fixes the terms, driver only spends against
them — is enforced structurally, not by trusting the client:

- Manager-set fields (`advance_minor`, `invoice_no`, `driver_phone`,
  `expected_return_on`, `diesel_litres`) live on `trips` and are written only by
  the schedule/close routes, which are dispatcher/driver respectively.
- Driver expenses live in `trip_expenses`, append-only, written only via
  `POST /trips/:ref/expenses` (driver role). There is no route, and no grant,
  for a driver to alter the advance or invoice.
- `trip_settlement` (view) computes total expenses, balance (owed to vs
  recoverable from the driver), distance and mileage in the database.

Diesel is litres, not cash — it feeds mileage (`distance_km / diesel_litres`)
and is settled on the fuel card, so it is not part of the expense total. This
matches the sample sheet, where diesel 500 L gives mileage 3.6 but is absent
from the ₹9,450 expense total. **Migration 005 and its API layer were written
but not run** — the app-control policy on this machine began blocking the
Postgres binaries mid-session, so unlike 001–004 the settlement view could not
be exercised against a live cluster. Verify with `settlement_check.sql` once a
cluster is reachable.

## Money

Stored as `bigint` minor units (paise) with GST in basis points. `total_minor`
is a generated column, so the total cannot drift from its parts. Nothing in the
cost path uses floating point.

## API surface

| Method | Route | Roles |
| --- | --- | --- |
| `POST` | `/api/v1/auth/login` | public |
| `POST` | `/api/v1/auth/refresh` | public |
| `DELETE` | `/api/v1/auth/sessions/:id` | fleet manager, admin |
| `POST` | `/api/v1/trips` | dispatcher and above |
| `GET` | `/api/v1/trips` | any (scoped) |
| `GET` | `/api/v1/trips/:tripRef` | any (scoped) — the report |
| `POST` | `/api/v1/trips/:tripRef/depart` | driver |
| `POST` | `/api/v1/trips/:tripRef/stops` | driver |
| `POST` | `/api/v1/trips/:tripRef/expenses` | driver |
| `POST` | `/api/v1/trips/:tripRef/arrive` | driver |
| `POST` | `/api/v1/maintenance/bills` | dispatcher and above |
| `POST` | `/api/v1/maintenance` | dispatcher and above |
| `GET` | `/api/v1/maintenance` | dispatcher and above |
| `GET` | `/api/v1/maintenance/summary` | dispatcher and above |
| `GET` | `/api/v1/maintenance/:recordRef/bill` | dispatcher and above |

Scoping: drivers see only their own trips, dispatchers only their depot, fleet
managers and admins the whole fleet. Cost data excludes drivers entirely.

Logging maintenance is two calls, because the schema will not accept a record
without evidence:

```
POST /maintenance/bills   (multipart: bill=<file>)  ->  { id: "<billId>", ... }
POST /maintenance         { ..., "billId": "<billId>" }
```

Omitting `billId` returns 400 "A maintenance record cannot be saved without an
attached bill." That message comes from the not-null violation, not from a
hand-written check.

## Not built yet

- The `tms-app.html` prototype still holds its own in-memory state and does not
  call this API. Repointing it is the next step.
- GPS ingestion (MQTT/AVL), geofence evaluation, and the live map depend on
  migration `003` and PostGIS.
- No automated TypeScript tests. `db/tests/invariants.sql` covers the schema.
