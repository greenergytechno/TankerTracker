# TankerTrack — Local Deployment

Two ways to run the stack locally. **Docker is the one-command path.** The
manual path is for the machine this was built on, which has PostgreSQL 18 but no
Node/Docker.

> **What actually runs where:** the frontend (manager + driver) is static and
> already runnable. The API is Node/NestJS and needs Node or Docker. The DB is
> PostgreSQL. On the build machine only the frontend could be launched (no Node,
> no Docker, and `psql` is blocked by an Application Control policy), so the API
> and migrations here are **written but not executed** — bring them up with
> Docker on any normal dev machine to run them for real.

---

## Option A — Docker (full stack, one command)

Prereqs: Docker Desktop (or Docker Engine + Compose v2).

```bash
cp .env.example .env
# edit .env — at minimum replace the two JWT secrets
docker compose up --build
```

That starts:

| Service | URL | What it is |
| --- | --- | --- |
| `db` | `localhost:5432` | PostgreSQL 16 + PostGIS |
| `minio` | `localhost:9000` / console `:9001` | S3-compatible bill storage |
| `api` | `http://localhost:3000/api/v1` | NestJS API (runs migrations on start) |
| `web` | `http://localhost:8080` | Manager site + driver app |

The `api` container runs `node scripts/migrate.js` on boot, applying
`db/migrations/001…005` (003 PostGIS is opt-in and skipped). It is idempotent —
restarts re-check `schema_migrations` and skip what's applied.

### Verify it came up

```bash
# API is alive and the DB is migrated (the API refuses to start otherwise)
curl -i http://localhost:3000/api/v1/trips        # 401 = up, auth working

# DB migrated
docker compose exec db psql -U postgres -d tankertrack -c "\dt"

# Run the schema invariant tests against the running DB
docker compose exec -T db psql -U postgres -d tankertrack -v ON_ERROR_STOP=1 \
  < apps/api/db/tests/invariants.sql

# Object store bucket exists
open http://localhost:9001   # login with the S3_* creds from .env
```

### Seed a manager/driver user

Users are created through the API (passwords are hashed), so there's no seed
file. Once auth endpoints are exercised, create a dispatcher and a driver via
`POST /api/v1/auth/...`. Until then, the reference data (depots + 15 vehicles)
is loaded by migration `002`.

---

## Option B — Manual (this machine: Postgres 18, no Node/Docker)

You have PostgreSQL 18 running as service `postgresql-x64-18`. You still need
**Node 20+** for the API and an S3-compatible store for bills.

### 1. Database

```bash
# as a Postgres superuser (needs your postgres password)
psql -U postgres -c "CREATE DATABASE tankertrack"
cd apps/api
# set DATABASE_URL in .env to your superuser first, then:
npm install
npm run migrate
npm run migrate -- --status
```

> On this machine `psql`/`initdb` are currently blocked by an Application
> Control (WDAC-style) policy. If a command dies with "An Application Control
> policy has blocked this file", the block is why — not the SQL. Migrations
> `001–004` were verified earlier via a throwaway cluster; `005` and the API
> have not been run here.

### 2. Object storage

Run MinIO (single binary) or point `S3_*` at any S3 bucket. Create a private
`tankertrack-bills` bucket.

### 3. API

```bash
cd apps/api
cp .env.example .env    # fill DATABASE_URL, JWT secrets, S3_*
npm run start:dev
```

### 4. Frontend

Already trivial — it's static:

```bash
py -m http.server 8000      # or: npx serve .
# manager: http://localhost:8000/tms-app.html
# driver:  http://localhost:8000/driver.html
```

(This is exactly what the `web` container does in Option A.)

---

## Important: the clients are not wired to the API yet

Both HTML clients still read/write their **in-browser store** (`store.js` →
localStorage), not the API. So after `docker compose up` you have a fully
migrated DB and a live API, and a working frontend — but they are not yet
talking to each other. Repointing the clients is the remaining Phase 2 task:
replace the body of `TankerStore.load/save` in `store.js` with `fetch()` calls
to `/api/v1/...` (plus a login flow for the token). Nothing else in the clients
changes — that indirection is why `store.js` exists.

---

## Hardening before this leaves a laptop

The compose file is tuned for a frictionless local run. Before any shared or
production environment:

- **Do not connect the API as the `postgres` superuser.** Migration `001`
  creates a least-privilege `tankertrack_app` role; give it a password and use
  it for the runtime `DATABASE_URL`. Run *migrations* as the superuser, the
  *app* as `tankertrack_app`.
- **Replace all secrets** and move them out of `.env` into a secret manager.
- **TLS everywhere** — the API, the DB connection (`DATABASE_SSL=require`,
  enforced by config when `NODE_ENV=production`), and MinIO.
- **Lock the MinIO bucket** to the API's credentials only; serve bills by
  presigned URL (already the code path).
- See [DESIGN-FLAWS.md](DESIGN-FLAWS.md) for the full list.
