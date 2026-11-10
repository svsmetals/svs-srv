import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requirePerm } from '../auth.js';
import { scopeOf } from '../permissions.js';
import { idWith, wrap } from '../lib/util.js';

export const clientRoutes = Router();
clientRoutes.use(authenticate);

// Build the WHERE fragment that enforces record visibility scope.
// Returns { sql, params } to append to a query already having `params`.
// `col` is an optional table-qualifier prefix for the owner_id column (e.g. 'c.').
function scopeFilter(user, params, col = '') {
  const scope = scopeOf(user);
  if (scope === 'all') return { sql: '', params };
  if (scope === 'location') {
    params.push(user.loc_id);
    return { sql: ` and ${col}owner_id in (select id from users where loc_id = $${params.length})`, params };
  }
  // own
  params.push(user.id);
  return { sql: ` and ${col}owner_id = $${params.length}`, params };
}

// Score bands — ported verbatim from index.html (clientScore / SCORE_BANDS).
const SCORE_BANDS = {
  annual: [[0, 1], [500000, 2], [2000000, 3], [7500000, 4], [20000000, 5]],
  freq:   [[0, 1], [2, 2], [5, 3], [10, 4], [20, 5]],
  single: [[0, 1], [100000, 2], [400000, 3], [1200000, 4], [3000000, 5]],
};
function band(v, rows) { let s = 1; rows.forEach(([min, pts]) => { if (v >= min) s = pts; }); return s; }

async function loadClient(id) {
  const { rows } = await query('select * from clients where id = $1', [id]);
  const client = rows[0];
  if (!client) return null;
  client.phones   = client.phones   || [];
  client.contacts = client.contacts || [];
  client.history  = client.history  || [];

  // Compute the legacy client score from the last 12 months of orders.
  // Legacy clientScore() counts ALL orders (including Cancelled) and uses a
  // date-based >= on the cutoff day — match that exactly.
  const { rows: sc } = await query(
    `select coalesce(sum(value),0)::numeric as annual_value,
            count(*)::int                  as freq_count,
            coalesce(max(value),0)::numeric as biggest
     from orders
     where client_id = $1
       and created_at::date >= current_date - 365`,
    [id]
  );
  const { annual_value, freq_count, biggest } = sc[0];
  const av = Number(annual_value), fc = Number(freq_count), bi = Number(biggest);
  const parts = {
    annual: band(av, SCORE_BANDS.annual),
    freq:   band(fc, SCORE_BANDS.freq),
    single: band(bi, SCORE_BANDS.single),
  };
  const overall = Math.round(((parts.annual + parts.freq + parts.single) / 3) * 10) / 10;
  client.score = { parts, overall, annual_value: av, freq_count: fc, biggest: bi };

  return client;
}

// GET /clients  — list, scoped. ?q= filters by normalized name / city / gstin.
clientRoutes.get(
  '/',
  wrap(async (req, res) => {
    let params = [];
    // Per-client aggregates computed server-side so the list matches the legacy
    // table: offers (all quotes), open (draft+sent), order_value (non-cancelled).
    // Select explicit columns (not c.*) to keep phones/history out of the list.
    let sql = `select c.id, c.name, c.norm, c.gstin, c.email, c.type, c.address,
        c.city, c.state, c.country, c.territory, c.owner_id, c.owner_since, c.created_at,
      (select count(*) from quotes q where q.client_id = c.id)::int as offers,
      (select count(*) from quotes q where q.client_id = c.id and q.status in ('Draft','Sent'))::int as open,
      coalesce((select sum(o.value) from orders o where o.client_id = c.id and o.status <> 'Cancelled'), 0) as order_value
      from clients c where 1=1`;
    if (req.query.q) {
      const raw = String(req.query.q).toLowerCase().trim();
      const alnum = raw.replace(/[^a-z0-9]+/g, ''); // match the way `norm` is stored
      params.push(`%${alnum}%`);
      const pNorm = params.length;
      params.push(`%${raw}%`);
      const pRaw = params.length;
      // name (normalized) OR city OR gstin
      sql += ` and (c.norm like $${pNorm} or lower(c.city) like $${pRaw} or lower(c.gstin) like $${pRaw})`;
    }
    const scoped = scopeFilter(req.user, params, 'c.');
    sql += scoped.sql + ' order by c.name';
    const { rows } = await query(sql, scoped.params);
    res.json(rows);
  })
);

// GET /clients/:id
clientRoutes.get(
  '/:id',
  wrap(async (req, res) => {
    const client = await loadClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'not found' });
    res.json(client);
  })
);

// POST /clients  — create
clientRoutes.post(
  '/',
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    if (!b.phone && !(b.phones && b.phones.length))
      return res.status(400).json({ error: 'at least one phone required' });

    const phones = b.phones && b.phones.length ? b.phones : [b.phone];
    const ownerId = b.owner_id || req.user.id;
    const norm = String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const id = idWith('CLI');
    const history = [{ at: new Date().toISOString(), to_user_id: ownerId, reason: 'Added manually', by_name: req.user.name }];

    await query(
      `insert into clients
        (id, name, norm, norm_full, gstin, email, type, address, city, state, country, territory, owner_id, owner_since, phones, contacts, history)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, current_date, $14::jsonb, $15::jsonb, $16::jsonb)`,
      [id, b.name, norm, norm, (b.gstin || '').toUpperCase(), b.email || '', b.type || '',
       b.address || '', b.city || '', b.state || '', b.country || '', b.territory || '', ownerId,
       JSON.stringify(phones), JSON.stringify([]), JSON.stringify(history)]
    );

    res.status(201).json(await loadClient(id));
  })
);

// PATCH /clients/:id  — update basic fields (and phones if given)
clientRoutes.patch(
  '/:id',
  wrap(async (req, res) => {
    const allowed = ['name', 'gstin', 'email', 'type', 'address', 'city', 'state', 'country', 'territory'];
    const sets = [];
    const params = [];
    for (const field of allowed) {
      if (field in (req.body || {})) {
        params.push(req.body[field]);
        sets.push(`${field} = $${params.length}`);
      }
    }
    if ('phones' in (req.body || {})) {
      params.push(JSON.stringify(req.body.phones || []));
      sets.push(`phones = $${params.length}::jsonb`);
    }
    if ('contacts' in (req.body || {})) {
      params.push(JSON.stringify(req.body.contacts || []));
      sets.push(`contacts = $${params.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.id);
    const { rowCount } = await query(
      `update clients set ${sets.join(', ')} where id = $${params.length}`,
      params
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json(await loadClient(req.params.id));
  })
);

// POST /clients/:id/transfer  { to_user_id, reason } — needs client.transfer
clientRoutes.post(
  '/:id/transfer',
  requirePerm('client.transfer'),
  wrap(async (req, res) => {
    const { to_user_id, reason } = req.body || {};
    if (!to_user_id) return res.status(400).json({ error: 'to_user_id required' });
    const entry = [{ at: new Date().toISOString(), to_user_id, reason: reason || 'Transferred', by_name: req.user.name }];
    const { rowCount } = await query(
      `update clients set owner_id = $1, owner_since = current_date, history = history || $2::jsonb where id = $3`,
      [to_user_id, JSON.stringify(entry), req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json(await loadClient(req.params.id));
  })
);

// DELETE /clients/:id  — needs client.delete
clientRoutes.delete(
  '/:id',
  requirePerm('client.delete'),
  wrap(async (req, res) => {
    const { rowCount } = await query('delete from clients where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  })
);
