# TankerTrack — Project Knowledge Transfer

**Ethanol fleet transport management system for Green Energy.**
Last updated 2026-08-27. Written for someone joining with zero context.

---

## 1. What this is, in one paragraph

Green Energy runs ~15 tanker trucks delivering ethanol from depots (Belagavi,
Dharwad) to clients such as BPCL Cochin. TankerTrack replaces the paper trip
sheet with two web clients over one shared store: a **manager console** for
dispatch, live tracking, costs and reports, and a **driver app** used in the cab
to run the trip. A manager schedules a trip; the assigned driver sees it on their
phone, starts it (which requires sharing live location), logs stops and expenses,
uploads the GRN, and closes it. The system then produces a trip report and a
standardised trip sheet with expenses, advance, balance, distance and mileage.

**The single most important thing to understand:** the production-shaped backend
(NestJS + PostgreSQL, in `apps/api/`) was fully written but has **never been
run**. What actually runs today is `server.py` — a pure-standard-library Python
server written as a working substitute. Do not assume `apps/api/` works.

---

## 2. How the project got here

The path matters, because the current architecture is a *reaction* to
environment constraints rather than a first choice.

| # | When | What happened |
|---|------|---------------|
| 1 | 2026-08-03 | Initial import. Requirements captured from the real Green Energy trip sheet (`9450rs.pdf`). |
| 2 | 2026-08-05 | Architecture + full NestJS/PostgreSQL API written; migrations 001–005; docs (ARCHITECTURE, DESIGN-FLAWS, DRIVER-APP-REQUIREMENTS, LOCAL-DEPLOYMENT). Docker compose stack defined. |
| 3 | 2026-08-05 | **The wall:** the dev machine had no Node.js, no Docker, and an application-control policy that blocked native binaries (`psql`, Pillow, lxml). The API could be written but never compiled or run; migration 005 was never applied. |
| 4 | 2026-08-05 | **The pivot:** `server.py` written in pure stdlib to be the real backend — serves both clients and a small JSON API, persisting to `data/store.json`. Design-exploration HTML deleted; two shipping clients kept. |
| 5 | 2026-08-05 | Breakdown approvals, mandatory GRN/expense bills, first location tracking, PWA shell. |
| 6 | 2026-08-11 | Manager/driver clients split properly; driver login added; then server-side auth — manager password + role-scoped driver API. |
| 7 | 2026-08-27 | Exposed publicly via Cloudflare tunnel. Mandatory live-location consent to start a trip; live fleet map; manager console moved behind a secret URL; planned route + % progress; unlogged-stop (stagnation) alerts. |

Two consequences of this history you will keep bumping into:

- **`store.js` is a deliberate seam.** Both clients call `TankerStore.load()` /
  `.save()`. Swapping localStorage for the HTTP API changed nothing in the UIs.
  It is where a real API gets wired in later.
- **Business rules currently live in the clients**, not the database. The
  NestJS/SQL design put them in Postgres (append-only tables, triggers, generated
  columns). That protection does not exist in what runs today.

---

## 3. Architecture as it runs today

```
Driver phone (browser)  ─┐
                         ├─► Cloudflare tunnel (HTTPS) ─► server.py :8000 ─► data/store.json
Manager browser         ─┘                                    │
                                                              └─► data/auth.json
```

- **One process, one file of truth.** `server.py` owns `data/store.json`; every
  write is a whole-store atomic replace with a bumped `rev`.
- **Sync is short polling.** Clients poll `/api/rev` every 2.5s and re-pull
  `/api/store` when `rev` advances.
- **HTTPS matters functionally**, not just for safety: browsers only expose the
  Geolocation API on HTTPS (or localhost), so driver tracking requires the tunnel
  URL — a plain `http://<LAN-IP>` address will not work.

---

## 4. Module-by-module

### 4.1 `server.py` — the backend (396 lines, pure stdlib) · **LIVE**

| Concern | Detail |
|---|---|
| Static serving | Strict allowlist (`STATIC_ALLOW`). Source, `.git` and `docs/` are never served. |
| Manager path | Console is served **only** at `/console/<secret>`; `/tms-app.html` returns 404. Secret persisted in `auth.json`, compared with `secrets.compare_digest`. Override with `MANAGER_PATH`. |
| Auth | `POST /api/login` issues an in-memory bearer token. Manager = password (SHA-256 in `auth.json`). Driver = roster id + PIN. Tokens die on restart. |
| Role scoping | `driver_view()` returns **only** that driver's own trips — no roster, no maintenance, no other drivers. |
| Write protection | `merge_driver_update()` merges only a driver's own trips. A driver cannot self-approve a breakdown, edit another trip, or replace the store, whatever they POST. |
| Persistence | `write_store()` — lock, bump `rev`, write temp, `os.replace` (atomic). |

Endpoints: `GET /api/store`, `GET /api/rev`, `PUT /api/store`, `POST /api/login`,
`POST /api/logout`. Every data call is 401 without a token.

### 4.2 `store.js` — shared data layer (169 lines) · **LIVE**

Loaded by both clients. Auto-selects **server mode** (talks to `/api/store`) or
falls back to **local mode** (localStorage) when no server is reachable. The
initial load is a *synchronous* XHR so the clients' existing synchronous
init still works. Token key is namespaced by `window.TANKER_ROLE`, so a driver's
token can never satisfy the manager console's gate. Blob URLs (`billUrl`,
`grnUrl`, `quoteUrl`) are stripped on save — file *names* persist, the files do not.

### 4.3 `driver.html` — driver app (925 lines) · **LIVE**

Mobile-shaped single-file client. Screens: login → home (assigned trips) →
depart → active → completed.

- **Trip start is gated three ways:** the scheduled start date (early start
  blocked, late allowed but flagged), a valid opening odometer (must be ≥ last
  recorded for that vehicle), and **live-location consent**.
- **Location** (`requestLocationConsent`): tries a high-accuracy fix, falls back
  to a coarse/cached one, and only rejects on a true permission denial or total
  failure. On success it keeps a `watchPosition` running plus a 20s heartbeat,
  writing position to the trip every 15s. Losing consent mid-trip sets
  `trackingLost`. Tracking stops on arrival and logout.
- **Stagnation anchor:** an in-memory anchor moves only when the truck travels
  >120 m; `stationarySince` rides along with the throttled save.
- **Mandatory evidence:** every expense needs a bill; closing the trip needs a GRN.

### 4.4 `tms-app.html` — manager console (2,481 lines) · **LIVE**

Two tabs: **Dispatch** and **Workshop & Costs**. Internal sections are marked
with `/* ---- name ---- */` comments.

| Section | What it does |
|---|---|
| Trip scheduler | Manager fixes vehicle, driver, route, max stops, load, dates, invoice, advance (default ₹5,000). The driver can change none of it. |
| Fleet snapshot | Live counters incl. unauthorized stops and unlogged idle. |
| Driver logins | Roster with ids/PINs to hand out; add drivers. |
| Breakdown approvals | Driver raises a roadside repair request; manager approves/rejects. |
| **Unlogged stop alerts** | Stationary >14 min with no stop logged → card with duration, reverse-geocoded location, route, shipment, invoice, deadline, driver phone. |
| **Live fleet map** | Leaflet + OpenStreetMap. Truck pins: green moving, amber idle, red signal lost. Planned route dashed, covered portion solid green. |
| Trip board / reports | All trips with progress bars; completed trips open a full report (duration, delivered kg, inactivity gaps, flagged stops). |
| Trip sheet | Standardised sheet modelled on the real `9450rs.pdf`. |
| Workshop & fuel | Maintenance bills (bill mandatory) and tank-to-tank mileage. |

**Route + progress** is resolved client-side because the scheduler only stores
route *names*: Nominatim geocodes them, OSRM returns the driving route, and the
truck's position is matched to the nearest point on that polyline. Results are
cached in localStorage — each route resolves once. If a truck is more than
**25 km** off its route, progress is reported as *off route* rather than a
misleading percentage (a far-away fix would otherwise snap to the finish and read
100%).

### 4.5 `data/` — the database · **LIVE**

`store.json` = `{rev, state}` where state holds `trips`, `fuelLog`,
`maintenance`, `breakdowns`, `drivers`, `seqs`. `auth.json` holds the manager
password hash and the console secret. **Back these up; they are the system of
record.** Current contents: 106 fuel readings, 16 maintenance records, 10 drivers.

Trip fields: `id, vehicle, driver, driverId, driverPhone, routeFrom, routeTo,
maxStops, loadKL, invoiceNo, advance, startDate, expectedReceiveDate, deadline,
gpsPoint, status, departure, arrival, openingOdometer, closingOdometer,
dieselLitres, stops[], expenses[], lastLocation, stationarySince, stationaryAt,
trackingLost, locationConsent, createdAt`.

### 4.6 `apps/api/` — NestJS + PostgreSQL · **WRITTEN, NEVER RUN**

~20 TypeScript files: `auth` (JWT, device binding, RBAC), `trips`
(schedule/depart/stops/expenses/arrive/report/settlement), `maintenance`,
`storage` (S3 presigned), `db`, `common` (audit, roles, DB exception filter).
Migrations 001–004 were verified against a throwaway cluster (20 invariant tests
passed); **005 was never applied**. Treat this as a reviewed design, not working
code. Its value: it encodes the rules in the database (append-only tables,
odometer monotonicity, one open trip per vehicle, money as bigint paise).

### 4.7 `docs/`, `docker-compose.yml`, `infra/` · **REFERENCE / NOT RUN**

`ARCHITECTURE.md`, `DESIGN-FLAWS.md` (17 ranked flaws with exploit + fix),
`DRIVER-APP-REQUIREMENTS.md`, `LOCAL-DEPLOYMENT.md`, plus `.docx` versions and
`PROJECT-STATUS` / `SECURITY-REPORT` / `TESTING-PLAN`. Compose defines
postgis 16-3.4 + MinIO + api + nginx — never run here.

---

## 5. Tech stack

| Layer | What runs today | What was designed for later |
|---|---|---|
| Backend | Python 3 stdlib (`http.server`) | NestJS (Node 20+), TypeScript |
| Data | JSON file, atomic replace | PostgreSQL 16 + PostGIS |
| Auth | Bearer tokens in memory, SHA-256 password | JWT + refresh, device binding, RBAC |
| Frontend | 3 hand-written HTML files, vanilla JS, no build step | React (web) + Expo (mobile) |
| Map | Leaflet 1.9.4 + OpenStreetMap tiles | — |
| Geocode/route | Nominatim + OSRM (free, no key) | Google/Mapbox if licensed |
| Files | Blob URLs, session-only | S3/MinIO presigned |
| Exposure | `cloudflared` quick tunnel | Named tunnel / real hosting |

No package manager, no bundler, no framework. Every client is one self-contained
file — deliberate, so it runs anywhere with a browser.

---

## 6. Domain rules worth memorising

- **Manager owns the trip; the driver owns only expenses** (plus odometer,
  diesel litres, stops, GRN).
- **Diesel is litres only**, never a cash expense — it is fuel-card settled and
  feeds mileage = distance ÷ litres.
- **Balance = total expenses − advance.** Positive → pay driver; negative → recover.
- **Odometer is monotonic** across trips and the fuel log.
- **No bill, no record** — expenses need a receipt, maintenance needs a bill,
  closing a trip needs a GRN.
- **Golden test values** (from the real sheet): advance 5,000; expenses 9,450;
  balance 4,450; opening 47,262; closing 49,060; distance 1,798 km; diesel 500 L;
  mileage 3.6 km/L.

Key thresholds in code: idle flag **14 min**; logged-stop tolerance **15 min**;
movement threshold **120 m**; off-route limit **25 km**; position save **15 s**;
heartbeat **20 s**; client poll **2.5 s**.

---

## 7. Security model — and its honest limits

**Two locks on the manager console:** it exists only at an unguessable path, and
that path still demands the password. `/tms-app.html` 404s, so handing out the
public driver URL cannot expose it.

**Enforced server-side:** every data call needs a token; drivers receive only
their own trips; driver writes merge into their own trips only.

**Prototype-grade — do not treat as production:**

- Driver PINs are stored in plaintext and derived deterministically (guessable).
- One shared manager password; no rate limiting, lockout, or token expiry.
- Locations are self-reported by the browser and could be spoofed.
- Uploaded bills/GRNs are session-only blob URLs — they do not survive a reload.
- Business rules live in the client, so a crafted request can bypass some of them.

See `docs/DESIGN-FLAWS.md` for the full ranked list.

---

## 8. Running it

```bash
cd TankerTracker
MANAGER_PASSWORD='choose-one' python3 server.py
```

Startup prints the driver URL, the secret manager path, and the password. To
expose it publicly:

```bash
cloudflared tunnel --url http://localhost:8000
```

- Driver app: `<url>/`
- Manager console: `<url>/console/<secret>`

Reset the manager password or console path by deleting `data/auth.json`
(this does **not** touch trip data). Quick-tunnel URLs change on every restart —
use a named Cloudflare tunnel for a stable address.

> Credentials and the console secret are deliberately **not** written in this
> document. Read them from the server's startup output or `data/auth.json`.

---

## 9. Where to pick up

1. **Persist uploaded files.** Bills and GRNs vanish on reload — the biggest
   functional gap in day-to-day use.
2. **Harden auth.** Per-driver hashed passwords, token expiry, rate limiting.
3. **Move rules server-side.** Validate trip transitions in `server.py` instead
   of trusting the client.
4. **Decide the backend's future:** either stand up `apps/api/` properly (needs
   Node + Docker + Postgres; apply and verify migration 005) or keep hardening
   `server.py`. Do not leave both half-alive.
5. **Server-side location ingest** so positions are recorded, not self-reported.
6. **Remove dead driver code** from `tms-app.html` (`renderDriver`, `wireDriver`,
   `lookupTrip`) left over from the client split.

---

## 10. Gotchas that will cost you an afternoon

- Opening the clients as `file://` breaks them — they must be served over HTTP.
- Geolocation silently fails on non-HTTPS origins; test through the tunnel.
- `data/store.json` is overwritten wholesale; concurrent manual edits are lost.
- Nominatim/OSRM are free community services with rate limits — that is why
  results are cached hard in localStorage.
- Tokens are in memory: restarting the server logs everyone out.
- The `.docx` files in `docs/` were assembled by hand in pure Python; there is no
  toolchain to regenerate them.
