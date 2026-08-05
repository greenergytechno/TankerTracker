# TankerTrack — Session Handoff / Context Transfer

**As of 2026-08-03.** Hand this to a fresh session to resume with full context.
It captures what the project is, what exists, what's verified vs. unrun, the
environment quirks that constrain everything, and what to do next.

---

## 1. What this project is

Ethanol fleet transportation management system for **Green Energy** (delivers
ethanol to clients like **BPCL, Cochin**). ~15 tanker trucks, ~2 depots. Two
roles / two clients over one API + DB:

- **Manager website** — dispatch scheduling, live fleet status, trip reports,
  workshop & maintenance costs, fuel/mileage tracking.
- **Driver app** (downloadable) — in-cab: open trip by ID → depart → log stops →
  add expenses → arrive. Offline-tolerant by design.

Core workflow: manager schedules a trip → gets a Trip ID → driver enters it →
logs the run → system auto-generates a report (duration, delivered quantity,
unauthorized stops, inactivity gaps) and a **standardised trip sheet**
(expenses, advance, balance, distance, mileage).

---

## 2. File map (where everything lives)

### Frontend — runnable, verified
- `tms-app.html` — **manager website** (Dispatch + Workshop & Costs tabs). Driver
  tab removed; has a "Driver App ↗" link. Persists via `store.js`.
- `driver.html` — **standalone driver app**, mobile-shaped (phone frame on
  desktop). Full in-cab flow.
- `store.js` — **shared data layer** both clients load. localStorage today; **this
  is the deliberate seam where real API `fetch()` calls slot in later.**
- `fleet-dashboard*.html` — older design explorations (reference only).

### Backend — written, NOT run (no Node on this machine)
- `apps/api/` — NestJS + PostgreSQL API.
  - `src/` — modules: `auth` (JWT + device binding + RBAC), `trips`
    (schedule/depart/stops/expenses/arrive/report/settlement), `maintenance`
    (bills + fuel), `storage` (S3 presigned), `db`, `common` (audit, roles,
    DB-exception filter).
  - `db/migrations/001…005` — schema. `db/tests/invariants.sql` — schema tests.
  - `Dockerfile`, `docker-entrypoint.sh`, `.env.example`, `README.md`.

### Deployment
- `docker-compose.yml` — full stack: db (Postgres+PostGIS), minio, api, web.
- `.env.example` — compose secrets template.
- `infra/nginx/default.conf` — serves the static frontend.

### Docs (`docs/`, both `.md` and `.docx`)
- `ARCHITECTURE.md` — system design, diagrams, data model, roadmap.
- `DESIGN-FLAWS.md` — 17 ranked loopholes/flaws with exploit + fix.
- `DRIVER-APP-REQUIREMENTS.md` — what it takes to ship the connected driver app.
- `LOCAL-DEPLOYMENT.md` — how to run the stack (Docker + manual).

### Reference input
- `C:\Users\COMP\Desktop\9450rs.pdf` — the real Green Energy trip sheet the
  standardised sheet was modelled on (scanned; extract with pypdf + raw JPEG
  streams — see §4).

---

## 3. Status of each piece

| Piece | Status | Notes |
| --- | --- | --- |
| Frontend (both clients + store) | ✅ built & **verified in browser** | Two-client split done; full round-trip verified (manager schedules → driver completes → manager report shows it). |
| DB schema migrations 001–004 | ✅ **verified** | Applied to a throwaway cluster; all 20 invariant tests pass. |
| DB migration 005 (trip-sheet expenses) | 🟡 written, **not run** | `psql` got blocked by app-control mid-session before it could be applied. |
| NestJS API (~20 TS files) | 🟡 written, **never compiled/run** | No Node here. Treat as reviewed-not-verified. Includes a real bug fix: `logExpense` now rejects completed trips (DESIGN-FLAWS #3). |
| Docker deployment | 🟡 written, **not run** | No Docker here. |
| Docs (4 × md + docx) | ✅ complete | docx built by hand in pure Python (see §4). |

---

## 4. ⚠️ CRITICAL environment constraints (this machine)

These shape *what can be executed vs. only written*. A resumer must know them.

- **PostgreSQL 18 is installed and running** (service `postgresql-x64-18`),
  `scram-sha-256` auth — every connection needs a password (not available).
- **No Node.js / npm / Docker.** The API and docker-compose can be written but
  not run here. TypeScript is uncompiled.
- **An Application Control (WDAC-style) policy intermittently blocks native
  binaries.** It has blocked `psql`/`initdb`, Pillow's `_imaging`, and `lxml`'s
  `etree` — mid-session, unpredictably. When a command dies with *"An
  Application Control policy has blocked this file"*, that's why, not the input.
- **Python 3.14 works via the `py` launcher** (`python` bare is not on PATH);
  `pip install` works, **but native-extension modules fail at import**. Use pure
  Python + stdlib, or Windows-native `System.Drawing` (via PowerShell
  `Add-Type`) for images.
- **Frontend runs** via `py -m http.server 8000` (also wired as
  `.claude/launch.json` → "tms-prototype"). **Must be served over http** —
  `file://` breaks the multi-file `<script src>` and `store.js` sharing.
- To read the scanned PDF: `pypdf` installs fine; extract page images as raw
  `DCTDecode` JPEG streams and resize via PowerShell `System.Drawing` (Pillow is
  blocked). The `.docx` files were built by assembling OOXML ZIPs in pure Python
  because pandoc/LibreOffice/Node/`python-docx` are all unavailable/blocked.

There is a memory note for this: `local-dev-environment` (see §8).

---

## 5. Key domain decisions & facts

- **Trip sheet** standardised from the real sheet (`9450rs.pdf`):
  - **Manager sets (locked):** vehicle, driver, phone, destination, max stops,
    load, deadline, **invoice/dispatch no.**, **advance** (default ₹5,000),
    **expected return date**.
  - **Driver adds (only thing they own):** expenses — standard heads **Food,
    Parking, Unloading, RTO Charges** + extras (Toll/Fine/…/Other) with optional
    receipt photo; plus closing odometer and **diesel litres**.
  - **Diesel is litres only** (feeds mileage = distance ÷ litres); it is **not**
    a cash expense (fuel-card settled). Matches the sheet.
  - **Balance = total expenses − advance** (positive → pay driver; negative →
    recover).
  - Sample sheet numbers (used as the golden test): advance 5000, expenses 9450,
    balance 4450, opening 47262, closing 49060, distance 1798, diesel 500 L,
    mileage 3.6 km/L.
- **Money:** API/DB use **bigint paise** + GST in basis points, generated total
  columns (no float). The HTML prototype still uses float rupees (DESIGN-FLAWS
  #10) — reconcile when wiring to the API.
- **Rules live in the database** (so a compromised client can't bypass them):
  append-only `trip_stops`/`trip_expenses`/`audit_log`; `maintenance.bill_id`
  NOT NULL ("no bill, no record"); odometer monotonic across trips *and* fuel
  log; one open trip per vehicle/driver; unauthorized-stop flag set by trigger.
- **Verified golden values:** fuel tank-to-tank mileage recovers each seeded
  truck's km/L to **0.000% error**; the trip report reproduces the prototype
  exactly (two inactivity gaps of 90 & 115 min, 14,160 kg delivered, 255 min).

---

## 6. Open items / next steps (priority order)

1. **Install Node 20+**, then in `apps/api`: `npm install && npm run typecheck`,
   run the API, and **apply/verify migration 005** with `db/tests/invariants.sql`
   and the scratch `settlement_check.sql`. This clears the biggest unknown
   (DESIGN-FLAWS #12).
2. **Wire the clients to the API** — replace the body of `TankerStore.load/save`
   in `store.js` with authenticated `fetch()` to `/api/v1/...`, add a login flow.
   Nothing else in the clients changes. (Phase 2 remaining.)
3. **Fix critical flaws** from `docs/DESIGN-FLAWS.md` — no client auth (#1),
   plaintext localStorage (#2), self-reported metrics (#4).
4. **Remove dead driver code** from `tms-app.html` (`renderDriver`, `wireDriver`,
   `lookupTrip`, `expensesCard`, `stopsCard`, `odometerHint`, `lastKnownOdometer`
   — defined but unused after the split).
5. **Port clients to React (web) + Expo (mobile)** — see
   `docs/DRIVER-APP-REQUIREMENTS.md`.
6. **GPS / geofence phase** — migration `003` (PostGIS) + ingest service;
   replaces the rule-based unauthorized-stop flag.

---

## 7. How to run what's runnable *now*

```bash
# Frontend (works on this machine)
cd "C:/Users/COMP/Downloads/Transport project"
py -m http.server 8000
# manager: http://localhost:8000/tms-app.html
# driver:  http://localhost:8000/driver.html   (they share live data via localStorage)
```

```bash
# Full stack — on any machine with Docker (NOT this one)
cp .env.example .env      # replace the two JWT secrets
docker compose up --build
# api:  http://localhost:3000/api/v1     web: http://localhost:8080
```

---

## 8. Persistent memory notes (in the assistant's memory store)

- `tms-app-is-a-reconstruction` — the "validated" prototype was rebuilt from the
  brief; don't assume its behaviour was signed off.
- `local-dev-environment` — the §4 constraints (Postgres yes; Node/Docker/PostGIS
  no; app-control blocks binaries; throwaway-cluster trick for SQL).
- `two-client-split` — the manager/driver/store.js split and that store.js is the
  API seam.

---

## 9. Git / working tree

Nothing from this session has been committed. New/changed files in the working
tree include: `tms-app.html`, `driver.html`, `store.js`, all of `apps/api/`,
`docker-compose.yml`, `.env.example`, `.gitignore`, `infra/`, and `docs/` (md +
docx). Run `git status` to confirm, and commit before handing off if you want a
clean baseline. **Do not commit `.env`** (only `.env.example`).

---

### One-paragraph summary

TankerTrack is a two-client ethanol-fleet TMS: a **manager website**
(`tms-app.html`) and a **driver app** (`driver.html`) that share one persistent
store (`store.js`) — verified working end-to-end in the browser. Behind them is a
**NestJS + PostgreSQL API** (`apps/api/`) whose schema is mostly verified but
whose TypeScript has **never been run** because this machine has no Node (and an
app-control policy that blocks `psql`, Docker isn't installed either). The
immediate path forward is: get Node/Docker on a build machine, run and verify the
API + migration 005, then repoint `store.js` from localStorage to the real API.
Full detail is in `docs/` (ARCHITECTURE, DESIGN-FLAWS, DRIVER-APP-REQUIREMENTS,
LOCAL-DEPLOYMENT).
