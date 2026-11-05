-- ============================================================================
-- SVS Sales Desk — Postgres schema (new backend)
-- Phase 1: users/roles, locations, clients, quotes, orders.
--
-- No offline/sync: the server is the single source of truth. There is no
-- `records`/`singles`/`tombstones` blob table and no svs_sync machinery.
--
-- STORAGE MODEL (middle-ground): a thing gets its own table only if something
-- does CRUD on it independently, or the app filters/joins/sorts by it across
-- records. Otherwise it rides inside its parent record as JSONB. So top-level
-- records are tables; their sub-collections (client.phones/history,
-- quote.items/charges/notes/events) are JSONB columns. This keeps the EXACT
-- legacy object shape (e.g. a quote item's dims/fin/ty/img) with no loss, which
-- also makes the Phase 3 data migration a near-straight copy.
--
-- IDs preserve the legacy scheme (CLI-…, U_…, ORD…, quote ids) so the migration
-- keeps all cross-references intact.
--
-- NOTE: this script is a CLEAN REBUILD — it drops the app tables first. Safe in
-- dev (no real data yet). Do NOT run as-is against a database holding real data;
-- a non-destructive ALTER migration will be written before that point.
-- ============================================================================

drop table if exists order_events cascade;
drop table if exists order_amendments cascade;
drop table if exists order_deliveries cascade;
drop table if exists orders cascade;
drop table if exists quote_events cascade;
drop table if exists quote_notes cascade;
drop table if exists quote_charges cascade;
drop table if exists quote_items cascade;
drop table if exists quote_sequences cascade;
drop table if exists quotes cascade;
drop table if exists client_owner_history cascade;
drop table if exists client_phones cascade;
drop table if exists clients cascade;
drop table if exists user_permissions cascade;
drop table if exists user_departments cascade;
drop table if exists users cascade;
drop table if exists settings cascade;
drop table if exists locations cascade;

-- ---------------------------------------------------------------------------
-- Locations (branches)
-- ---------------------------------------------------------------------------
create table locations (
  id    text primary key,
  name  text not null,
  code  text,
  line  text,
  addr  text
);

-- ---------------------------------------------------------------------------
-- Users. Role defaults live in app code (permissions.js); the DB stores
-- identity plus per-user overrides and departments (still their own tables this
-- round — they are read in the auth path and may be queried later).
-- ---------------------------------------------------------------------------
create table users (
  id         text primary key,
  username   text not null unique,
  name       text not null,
  code       text,                      -- short code printed by the name, e.g. "DR"
  role       text not null check (role in ('master','manager','exec','dispatch')),
  loc_id     text references locations(id),
  phone      text,
  email      text,
  dob        date,
  pin_hash   text,
  scope      text check (scope in ('all','location','own')),
  -- Team lead printed on this person's quotations.
  lead_name  text,
  lead_phone text,
  lead_email text,
  -- Usual leave cover (who holds their work when away) + the leave record
  -- itself ({ on, from, to, note, by, ts }). The mark-away flow lives in the HR
  -- module; these capture the data so nothing is dropped.
  backup_id  text references users(id) on delete set null,
  leave      jsonb not null default '{}'::jsonb,
  -- Per-person screen overrides on top of what their departments give.
  add_tabs   jsonb not null default '[]'::jsonb,
  no_tabs    jsonb not null default '[]'::jsonb,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index users_loc_idx on users(loc_id);

create table user_departments (
  user_id text not null references users(id) on delete cascade,
  dept    text not null,
  primary key (user_id, dept)
);

create table user_permissions (
  user_id text not null references users(id) on delete cascade,
  perm    text not null,
  granted boolean not null,
  primary key (user_id, perm)
);

-- ---------------------------------------------------------------------------
-- Clients. phones and ownership history ride as JSONB (edited only as part of
-- the client; no independent CRUD). norm/norm_full are search-normalized names.
--   phones:  ["9876543210", ...]
--   history: [{ at, to_user_id, reason, by_name }, ...]
-- ---------------------------------------------------------------------------
create table clients (
  id          text primary key,
  name        text not null,
  norm        text,
  norm_full   text,
  gstin       text,
  email       text,
  type        text,
  address     text,
  city        text,
  state       text,
  country     text,
  territory   text,
  owner_id    text references users(id),
  owner_since date,
  phones      jsonb not null default '[]'::jsonb,
  history     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index clients_owner_idx on clients(owner_id);
create index clients_norm_idx  on clients(norm);

-- ---------------------------------------------------------------------------
-- Quotes. Line items, charges, notes and events ride as JSONB — each keeps its
-- exact legacy object shape. Computed totals are stored as columns (as legacy
-- did) so list queries stay cheap.
--   items:   [{ kind:'item'|'heading'|'break', description, qty, uom, rate,
--               dims?, fin?, ty?, tpl?, note?, img? }, ...]   (extra keys preserved)
--   charges: [{ description, amount }, ...]
--   notes:   ["...", ...]
--   events:  [{ at, by_name, text }, ...]
-- ---------------------------------------------------------------------------
create table quotes (
  id          text primary key,
  no          int,                      -- null while a Draft
  rev         int not null default 0,
  fy          text,
  label       text,
  client_id   text references clients(id),
  user_id     text references users(id),
  loc_id      text references locations(id),
  enquiry_id  text,
  quote_date  date,
  validity    text,
  gst         numeric,
  status      text not null default 'Draft'
              check (status in ('Draft','Sent','Won','Lost','Superseded')),
  revise_of   text references quotes(id),
  follow_up   date,
  items       jsonb not null default '[]'::jsonb,
  charges     jsonb not null default '[]'::jsonb,
  notes       jsonb not null default '[]'::jsonb,
  events      jsonb not null default '[]'::jsonb,
  items_count int  not null default 0,
  total       numeric not null default 0,   -- basic (Σ qty*rate)
  extra       numeric not null default 0,   -- Σ charges
  taxable     numeric not null default 0,
  gst_amt     numeric not null default 0,
  grand       numeric not null default 0,
  created_at  timestamptz not null default now()
);
create index quotes_client_idx on quotes(client_id);
create index quotes_user_idx   on quotes(user_id);
create index quotes_fy_no_idx  on quotes(fy, no);

-- Per-financial-year offer number allocator (its own table — updated with a row
-- lock during allocation).
create table quote_sequences (
  fy      text primary key,
  next_no int not null
);

-- ---------------------------------------------------------------------------
-- Orders. (Sub-collections still use child tables this round; they will move to
-- JSONB when the Orders screen is built, to match the clients/quotes model.)
-- ---------------------------------------------------------------------------
create table orders (
  id            text primary key,
  pi            text,
  pi_ts         timestamptz,
  pi_by         text,
  cleared       boolean not null default false,
  cleared_ts    timestamptz,
  cleared_by    text,
  quote_id      text references quotes(id),
  enquiry_id    text,
  client_id     text references clients(id),
  owner_id      text references users(id),
  loc_id        text references locations(id),
  value         numeric not null default 0,
  promised      date,
  orig_promised date,
  priority      boolean not null default false,
  note          text,
  status        text not null default 'Pending'
                check (status in ('Pending','Partly delivered','Delivered','On hold','Cancelled')),
  stage         text not null default 'Commercial'
                check (stage in ('Commercial','Production','Quality','Planning','Dispatch','Billing')),
  created_at    timestamptz not null default now(),
  created_by    text references users(id),
  won_ts        timestamptz
);
create index orders_client_idx on orders(client_id);
create index orders_quote_idx  on orders(quote_id);
create index orders_status_idx on orders(status);

create table order_deliveries (
  id       bigint generated always as identity primary key,
  order_id text not null references orders(id) on delete cascade,
  at       timestamptz not null default now(),
  qty      numeric,
  note     text,
  by_name  text
);

create table order_amendments (
  id          bigint generated always as identity primary key,
  order_id    text not null references orders(id) on delete cascade,
  at          timestamptz not null default now(),
  from_date   date,
  to_date     date,
  reason      text,
  status      text,
  by_name     text
);

create table order_events (
  id       bigint generated always as identity primary key,
  order_id text not null references orders(id) on delete cascade,
  at       timestamptz not null default now(),
  by_name  text,
  text     text
);

-- ---------------------------------------------------------------------------
-- Company settings — a singleton config blob (letterhead, terms, bank, notes).
-- ---------------------------------------------------------------------------
create table settings (
  id   int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb
);
