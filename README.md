# SVS Sales Desk — Backend (Phase 1)

Express + Postgres backend replacing the old client-heavy sync model. The server
is the single source of truth; there is **no offline sync** (see `../MIGRATION-PLAN.md`).

This phase covers: **auth, users/roles, clients, quotes, orders**.

## Setup

```bash
cd backend
npm install
cp .env.example .env          # then edit DATABASE_URL and JWT_SECRET
createdb svsdesk              # or point DATABASE_URL at an existing Postgres
npm run migrate              # applies db/schema.sql
npm run dev                  # starts on http://localhost:4000
```

## Layout

```
db/
  schema.sql          normalized schema (locations, users, clients, quotes, orders)
  migrate.js          applies schema.sql
src/
  server.js           entry point
  app.js              express app + route wiring + error handler
  config.js           env config
  db.js               pg pool + withTransaction helper
  auth.js             PIN hashing, JWT, authenticate + requirePerm middleware
  permissions.js      PERMS + ROLE_DEFAULTS + can() (ported from the old app)
  lib/
    quoteNumbering.js FY-based offer number allocation (race-safe)
    util.js           id generation, async wrapper
  routes/
    auth.js           POST /auth/login, GET /auth/me
    clients.js        CRUD + transfer (scope-aware)
    quotes.js         CRUD + send + status (draft -> sent -> won/lost)
    orders.js         win-from-quote + stage/dispatch updates
    users.js          directory + manage + permission overrides
```

## API summary

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | `{username, pin}` → `{token, user}` |
| GET | `/auth/me` | auth | current user + resolved perms |
| GET | `/clients` | auth | scoped by role (all/location/own); `?q=` |
| POST | `/clients` | auth | create |
| PATCH | `/clients/:id` | auth | edit fields |
| POST | `/clients/:id/transfer` | `client.transfer` | change owner |
| DELETE | `/clients/:id` | `client.delete` | |
| GET | `/quotes` | auth | `?status=` `?client_id=` |
| POST | `/quotes` | `quote.create` | draft, or `{send:true}` to number it |
| PATCH | `/quotes/:id` | `quote.create` | edit draft + line items |
| POST | `/quotes/:id/send` | `quote.create` | allocate FY number, mark Sent |
| POST | `/quotes/:id/status` | `quote.create` | Lost / Superseded |
| GET | `/orders` | auth | `?status=` `?stage=` |
| POST | `/orders/win` | `quote.create` | raise the single order for a won offer |
| PATCH | `/orders/:id` | `dispatch.update` | stage / status / promised |
| POST | `/orders/:id/deliver` | `dispatch.update` | record (partial) delivery |
| POST | `/orders/:id/cancel` | `dispatch.amend` | call the order off |
| GET | `/users` | auth | directory |
| POST | `/users` | `user.manage` | add person |
| PATCH | `/users/:id` | `user.manage` | edit / reset PIN |
| PUT | `/users/:id/permissions` | `user.manage` | set per-user overrides |

## Known follow-ups

- **PIN migration:** legacy PINs are hashed with a different client-side scheme.
  Existing users need a PIN reset on cutover unless that algorithm is ported
  into `auth.js`.
- **Data migration:** a one-time script to copy Supabase `records`/`singles`
  JSON into these tables is Phase 3 (not written yet).
- **Tests:** no tests yet — add route tests against a throwaway Postgres (or
  pglite) before relying on this in production.
