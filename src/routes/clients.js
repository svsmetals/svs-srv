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

// ---------------------------------------------------------------------------
// Duplicate / similarity helpers — ported from legacy findLikely() block.
// ---------------------------------------------------------------------------

// Strips noise suffixes and normalises to alphanumeric only — legacy dqNorm().
function dqNorm(n) {
  return String(n || '').toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(pvt|private)\b/g, 'p')
    .replace(/\b(ltd|limited)\b/g, 'l')
    .replace(/\b(co|company|corp|corporation|inds|industries|enterprises|ent)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const NAME_NOISE = new Set([
  'pvt','private','ltd','limited','co','company','corp','corporation',
  'inds','industries','industry','enterprises','enterprise','ent','and','the','of','llp','inc',
  'international','india','indian','group','works','sons','bros','brothers','trading','traders',
  'engineers','engineering','electricals','electrical','electric','systems','system','solutions',
]);

// Extract stemmed meaningful words — same stem logic as legacy nameKey().
function meaningfulWords(n) {
  return String(n || '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, ''))
    .filter((w) => w.length > 2 && !NAME_NOISE.has(w));
}

// Sorted meaningful-word key — legacy nameKey().
const nameKey = (n) => meaningfulWords(n).sort().join(' ');

// ---------------------------------------------------------------------------

// GET /clients/similar  — must come before GET /:id so Express doesn't consume
// "similar" as an id parameter.
clientRoutes.get(
  '/similar',
  wrap(async (req, res) => {
    const { name = '', phone = '', gstin = '', email = '' } = req.query;
    const hits = [];
    const seen = new Set();

    function push(row, why, how) {
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      hits.push({
        id: row.id, name: row.name, city: row.city || '', gstin: row.gstin || '',
        owner_id: row.owner_id, owner_name: row.owner_name || row.owner_id || '—',
        quotes_count: Number(row.quotes_count) || 0, why, how,
      });
    }

    const base = `
      select c.id, c.name, c.city, c.gstin, c.owner_id,
             u.name as owner_name,
             (select count(*)::int from quotes q where q.client_id = c.id) as quotes_count
      from clients c
      left join users u on u.id = c.owner_id`;

    // 1. GSTIN — certain
    const g = String(gstin).toUpperCase().replace(/\s/g, '');
    if (g.length >= 15) {
      const { rows } = await query(`${base} where upper(replace(c.gstin,' ','')) = $1`, [g]);
      rows.forEach((r) => push(r, 'the same GST number', 'certain'));
    }

    // 2. Phone (last 10 digits) — likely
    const ph = String(phone).replace(/\D/g, '').slice(-10);
    if (ph.length === 10) {
      const { rows: pr } = await query(
        `${base} where exists (
           select 1 from jsonb_array_elements_text(c.phones) p
           where right(regexp_replace(p,'[^0-9]','','g'),10) = $1
         )`, [ph]
      );
      pr.forEach((r) => push(r, 'the same mobile number', 'likely'));
      // Also check contact-level phones
      const { rows: cr } = await query(
        `${base} where exists (
           select 1 from jsonb_array_elements(c.contacts) ct
           where right(regexp_replace(ct->>'phone','[^0-9]','','g'),10) = $1
         )`, [ph]
      );
      cr.forEach((r) => push(r, 'the same mobile number', 'likely'));
    }

    // 3. Corporate email domain — likely (skip free providers)
    const FREE = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
      'rediffmail.com','live.com','icloud.com','yahoo.co.in','ymail.com']);
    const dom = String(email).toLowerCase().split('@')[1] || '';
    if (dom && !FREE.has(dom)) {
      const { rows } = await query(
        `${base} where lower(split_part(c.email,'@',2)) = $1`, [dom]
      );
      rows.forEach((r) => push(r, `the same email domain (${dom})`, 'likely'));
    }

    // 4. Name matching — load candidates sharing a meaningful word, compare in JS
    if (name.trim()) {
      const qDqn = dqNorm(name);
      const qKey = nameKey(name);
      const words = meaningfulWords(name).filter((w) => w.length > 2);

      if (words.length > 0) {
        const cond = words.map((_, i) => `lower(c.name) like $${i + 1}`).join(' or ');
        const { rows: cands } = await query(
          `${base} where ${cond}`,
          words.map((w) => `%${w}%`)
        );
        for (const c of cands) {
          const cDqn = dqNorm(c.name);
          const cKey = nameKey(c.name);
          if (qDqn.length > 0 && qDqn === cDqn) {
            push(c, 'effectively the same name', 'likely');
          } else if (qDqn.length > 6 && (cDqn.startsWith(qDqn) || qDqn.startsWith(cDqn))) {
            push(c, 'a very similar name', 'possible');
          } else if (qKey && qKey === cKey) {
            push(c, 'the same words in the name', 'likely');
          } else if (qKey && cKey) {
            const qa = qKey.split(' '), ca = cKey.split(' ');
            const shared = qa.filter((w) => ca.includes(w)).length;
            if (shared && shared === Math.min(qa.length, ca.length) && Math.max(qa.length, ca.length) <= shared + 1) {
              push(c, 'nearly the same name', 'possible');
            }
          }
        }
      }
    }

    const rank = { certain: 0, likely: 1, possible: 2 };
    hits.sort((a, b) => rank[a.how] - rank[b.how]);
    res.json(hits.slice(0, 8));
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

// POST /clients/import  — bulk create from a sheet preview.
// Accepts { rows: [{ name, type, phones, gstin, email, address, city, state,
//   country, territory, owner_id }] }.  Re-checks each row for dups server-side
// (by norm name / GSTIN / phone overlap) so concurrent uploads don't collide.
// Returns { added: [...], dups: [...], bad: [...] }.
// Needs client.transfer OR master/manager role (same gate as the legacy mayImport).
clientRoutes.post(
  '/import',
  wrap(async (req, res) => {
    const { user } = req;
    const allowed = user.role === 'master' || user.role === 'manager'
      || (user.perms && user.perms['client.transfer'] === true);
    if (!allowed) return res.status(403).json({ error: 'Only a master or manager can import clients in bulk.' });

    const inRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const added = [], dups = [], bad = [];

    for (const o of inRows) {
      if (!o.name) { bad.push({ name: '(no name)', why: 'missing name' }); continue; }
      if (!o.phones?.length) { bad.push({ name: o.name, why: 'missing phone' }); continue; }

      const nm = String(o.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
      const g  = String(o.gstin || '').toUpperCase().replace(/\s/g, '');
      const ph = (o.phones || []).map((p) => String(p).replace(/\D/g, '').slice(-10)).filter((p) => p.length === 10);

      let dupSql = `select id, name from clients where norm = $1`;
      const dpParams = [nm];
      if (g.length >= 15) { dpParams.push(g); dupSql += ` or (gstin != '' and gstin = $${dpParams.length})`; }
      const { rows: existing } = await query(dupSql, dpParams);

      let phoneDup = null;
      if (ph.length) {
        for (const p of ph) {
          const { rows: pr } = await query(
            `select id, name from clients where phones @> $1::jsonb limit 1`,
            [JSON.stringify([p])]
          );
          if (pr.length) { phoneDup = pr[0]; break; }
        }
      }

      if (existing.length) {
        dups.push({ name: o.name, why: 'already on the register as ' + existing[0].name }); continue;
      }
      if (phoneDup) {
        dups.push({ name: o.name, why: 'phone already on the register under ' + phoneDup.name }); continue;
      }

      const ownerId = o.owner_id || user.id;
      const id = idWith('CLI');
      const history = [{ at: new Date().toISOString(), to_user_id: ownerId, reason: 'Bulk import', by_name: user.name }];

      await query(
        `insert into clients
           (id, name, norm, norm_full, gstin, email, type, address, city, state, country, territory, owner_id, owner_since, phones, contacts, history)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, current_date, $14::jsonb, '[]'::jsonb, $15::jsonb)`,
        [id, o.name, nm, nm,
         (o.gstin || '').toUpperCase(), o.email || '', o.type || '',
         o.address || '', o.city || '', o.state || '', o.country || '', o.territory || '',
         ownerId, JSON.stringify(o.phones), JSON.stringify(history)]
      );

      const ownerName = (await query('select name from users where id = $1', [ownerId])).rows[0]?.name || ownerId;
      added.push({
        id, name: o.name, type: o.type || '',
        where: (o.country || o.city || '') + (o.territory ? ' · ' + o.territory : ''),
        owner: ownerName,
      });
    }

    res.json({ added, dups, bad });
  })
);
