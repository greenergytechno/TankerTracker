# TankerTrack — Loopholes & Design Flaws

An honest audit of where the current design can be gamed, broken, or exploited —
across the two HTML clients, the API, the schema, and the architecture. Each
item: **what it is · how it's exploited · the fix**. Ordered by severity.

Scope note: several items are "prototype vs. product" gaps — the HTML clients
are stand-ins and deliberately lighter than the API. Those are still listed,
because shipping the prototype as-is would carry them.

---

## Severity summary

| # | Flaw | Layer | Severity |
| --- | --- | --- | --- |
| 1 | Clients have no authentication at all | Prototype | 🔴 Critical |
| 2 | All data in plaintext localStorage | Prototype | 🔴 Critical |
| 3 | Expenses accepted on already-completed trips | API | 🔴 Critical |
| 4 | Self-reported odometer / weight / diesel — no ground truth | Design | 🔴 Critical |
| 5 | Sequential, guessable IDs (TS-, MR-, EX-) | API/DB | 🟠 High |
| 6 | Device binding uses a client-supplied fingerprint | API | 🟠 High |
| 7 | No approval gate before driver payout | Design | 🟠 High |
| 8 | Trip-expense receipts optional and not deduped | API | 🟠 High |
| 9 | No idempotency — double-submits duplicate rows | Both | 🟠 High |
| 10 | Money is float on the client, paise on the server | Both | 🟠 High |
| 11 | Cross-tab store trusted without validation | Prototype | 🟡 Medium |
| 12 | Backend + migration 005 written but never run | API | 🟡 Medium |
| 13 | No transport security assumed locally | Infra | 🟡 Medium |
| 14 | Inactivity/geofence rules are still rule-based | Design | 🟡 Medium |
| 15 | No rate limiting on the (future) GPS ingest | Design | 🟡 Medium |
| 16 | Bill blobs are session-only object URLs | Prototype | 🟢 Low |
| 17 | Dead driver code shipped in the manager site | Prototype | 🟢 Low |

---

## 🔴 Critical

### 1. The clients have no authentication
**What:** `tms-app.html` and `driver.html` have no login. The driver "identity"
is whatever trip they open; the manager console is wide open. Anyone who loads
the page is a full manager or any driver.
**Exploit:** open the URL → schedule trips, alter costs, complete anyone's trip,
read every driver's PII. The driver app trusts a typed Trip ID as the only gate.
**Fix:** the API already has JWT + RBAC + device binding. Repoint the clients at
it (see [LOCAL-DEPLOYMENT.md](LOCAL-DEPLOYMENT.md)) and require login before any
action. No client action should be possible without a valid access token whose
role permits it. The driver may only open trips where `driver_id = self`.

### 2. All data sits in plaintext localStorage
**What:** the shared store is `localStorage['tankertrack.v1']` — trips, driver
phone numbers, expenses, everything, unencrypted, readable by any script on the
origin.
**Exploit:** a single XSS (or a malicious browser extension) reads or rewrites
the entire fleet's data. There is no integrity check on hydrate, so injected
data is accepted verbatim by both clients.
**Fix:** localStorage is a prototype crutch — the real store is the API/DB with
data encrypted at rest and access gated by token. Until then, treat the
prototype as demo-only and never load real driver PII into it. Add a strict CSP
and audit every `innerHTML` sink (see #11).

### 3. Expenses can be added to a completed trip (API)
**What:** `TripsService.logExpense` only blocks `status === 'cancelled'`. A
**completed** trip still accepts new expense lines.
**Exploit:** a driver (or a stolen driver token) completes a trip, sees the
settled balance, then posts more expenses after the fact to inflate the payout —
after the manager has already reviewed it.
**Fix:** reject expenses unless the trip is `active` (or `scheduled`). Once
`arrival_at` is set, the sheet is closed. Add a DB-level guard too: a trigger on
`trip_expenses` that rejects inserts when the parent trip is `completed`/
`cancelled`, so it can't be bypassed. This is a real code bug, not just a policy
gap — fix it in `logExpense` now.

### 4. Odometer, weight and diesel are self-reported with no ground truth
**What:** distance, delivered quantity, and mileage all come from numbers the
driver types. The only check is that the odometer doesn't go *backwards*.
**Exploit:**
- Inflate closing odometer → overstate distance → hide personal use of the
  truck, or justify more fuel.
- Understate diesel litres → flatter mileage → mask pilferage.
- Manipulate departure/arrival weights → hide short-delivery of ethanol.
**Fix:** cross-check against independent sources: GPS-derived distance (the
geofence/ingest phase) vs. odometer delta; fuel-card litres vs. driver-entered
diesel; weighbridge integration vs. typed weights. Flag divergence beyond a
tolerance on the report (the ±2% weight-variance flag is the pattern to extend).
Until GPS lands, this is an accepted, documented risk — say so to the business.

---

## 🟠 High

### 5. Sequential, guessable identifiers
**What:** `TS-4821`, `MR-1017`, `EX-1` increment predictably.
**Exploit:** even though access is scoped, sequential IDs leak fleet volume
(how many trips/bills exist) and let an attacker enumerate/probe systematically.
A leaked Trip ID is trivially incremented to guess neighbours.
**Fix:** keep the human-friendly ref for display, but make the **API address
trips by their UUID**, not the ref. Never let the ref be the only thing gating
access (it isn't today — scoping helps — but don't rely on ID secrecy).

### 6. Device binding trusts a client-supplied fingerprint
**What:** login takes a `deviceFingerprint` string from the client and binds the
session to it.
**Exploit:** a thief with a stolen refresh token can send the same fingerprint
string and impersonate the device; the fingerprint is not attested.
**Fix:** derive/attest the device identity server-side where possible (platform
attestation: Play Integrity / DeviceCheck), or at minimum bind additional
signals (IP range, TLS client characteristics) and alert on change. Keep remote
revoke (already present) as the backstop.

### 7. No approval gate before payout
**What:** the settlement balance ("pay driver ₹4,450") is computed and presented
as final the moment the driver ends the trip. The three signature slots
(Vehicle Incharge / Accounts Manager / GM) are decorative.
**Exploit:** without a real approve/reject step, an inflated or mistaken expense
sheet flows straight to "amount to pay" with no human sign-off recorded.
**Fix:** add an approval state machine: `submitted → approved/queried → settled`,
each transition attributed in the audit log, each signature a real authenticated
action. Payout references the *approved* total, not the raw one.

### 8. Trip-expense receipts are optional and not deduped
**What:** unlike maintenance bills (`NOT NULL`, checksum-deduped), trip expenses
can have no receipt, and the same receipt image can back many expenses.
**Exploit:** claim cash expenses with no evidence; or photograph one ₹1,800
parking slip and attach it to three trips.
**Fix:** decide a policy per head (e.g. Parking/RTO require a receipt; Food up to
a cap may not). Checksum-dedupe expense receipts the way maintenance bills are,
and flag a receipt reused across trips.

### 9. No idempotency — double-submit creates duplicates
**What:** neither client nor API carries an idempotency key. A double-tap or a
retried request after a flaky connection logs the stop/expense twice.
**Exploit:** accidental or deliberate duplicate expense lines inflate the total;
duplicate stops distort the report.
**Fix:** client generates a UUID per action; the API upserts on it. Essential
before the offline queue ships (a replay must not double-post) — it's already
called out in the architecture doc, just not implemented.

### 10. Two different money models
**What:** the API/DB use `bigint` paise with generated totals (correct). The
HTML clients compute money in floating-point rupees.
**Exploit:** rounding drift between what the driver/manager see and what the
server settles; reconciliation disputes.
**Fix:** when the clients move onto the API, adopt paise end-to-end and let the
server be the single source of the total. Never round on the client.

---

## 🟡 Medium

### 11. Cross-tab store is trusted blindly
**What:** `TankerStore.onExternalChange` hydrates whatever arrives in the
`storage` event with no validation, and both clients build `innerHTML` from
stored strings.
**Exploit:** anything that can write localStorage (XSS, extension) drives both
clients; a missed `esc()` anywhere becomes stored-XSS.
**Fix:** validate/shape data on hydrate; add a CSP; audit every `innerHTML`.
Moot once the store is the API, but relevant while it's localStorage.

### 12. The backend and migration 005 have never been run
**What:** no Node on the build machine, so ~20 API files were never compiled and
migration `005` never executed (app-control blocked `psql`).
**Exploit:** unknown runtime/type bugs; a broken migration only discovered on
first real deploy.
**Fix:** `docker compose up` (or Node locally) → `npm run typecheck`, run the
API, and apply/verify `005` with `invariants.sql` + `settlement_check.sql`.
Treat everything in `apps/api` as reviewed-not-verified until then.

### 13. No transport security assumed
**What:** local runs are plain HTTP; tokens and PII would cross the wire in the
clear.
**Fix:** TLS on the API, DB (`DATABASE_SSL=require` in prod, already enforced by
config), and MinIO; HSTS on the web tier. Cert-pin in the mobile app (see the
driver-app requirements).

### 14. "Unauthorized stop" is still a rule, not a geofence
**What:** a stop is flagged only if marked Unscheduled or over the max-stops
count. A driver can stop anywhere off-route and mark it "Break" within the
limit.
**Fix:** the planned PostGIS geofence-deviation check (migration `003` + ingest)
is the real control; the rule is a placeholder. Documented as an open decision.

### 15. GPS ingest has no abuse controls yet
**What:** the future ingest endpoint could be flooded with spoofed positions.
**Fix:** per-device auth + rate limiting + sanity bounds on the ingest path
(the schema already rejects future-dated pings); design it in before trackers
are connected.

---

## 🟢 Low

### 16. Bill blobs are session-only
**What:** uploaded bills are `URL.createObjectURL` blobs, dropped on persist —
only the filename survives a reload or the cross-client hop.
**Fix:** real object storage (already coded server-side) makes this moot.

### 17. Dead driver code in the manager site
**What:** `tms-app.html` still defines the old driver functions (never called)
after the split.
**Fix:** delete `renderDriver`, `wireDriver`, `lookupTrip`, `expensesCard`,
`stopsCard`, `odometerHint`, `lastKnownOdometer` from the manager file. Low risk,
just hygiene.

---

## The one-line version for the business

The prototype is a faithful **workflow** demo but is **not secure or
tamper-evident** — no auth, plaintext local data, and every trip metric is
self-reported. The API is designed to fix most of this (auth, RBAC, append-only
audit, DB-enforced invariants) but is **unrun**, and the clients don't use it
yet. The irreducible business risk even after wiring it all up is #4:
**without GPS and weighbridge/fuel-card integration, the numbers a trip is paid
on are whatever the driver typed.** That integration is the thing that turns
this from a logbook into a control.
