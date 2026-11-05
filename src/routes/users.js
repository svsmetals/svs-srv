import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { authenticate, requirePerm, hashPin } from '../auth.js';
import { can, ROLE_DEFAULTS } from '../permissions.js';
import { wrap } from '../lib/util.js';

export const userRoutes = Router();
userRoutes.use(authenticate);

// Derive a stable id from the username, mirroring the legacy seedId() intent
// (same person = same id everywhere).
function userId(username) {
  const u = String(username).toLowerCase();
  let h = 0;
  for (let i = 0; i < u.length; i++) h = ((h << 5) - h + u.charCodeAt(i)) | 0;
  return `U_${u}_${Math.abs(h).toString(36)}`;
}

// The columns that make up a directory row — everything the Users & rights
// screen draws, plus the per-user overrides, departments and owned-account
// count. No pin_hash ever leaves the server.
const DIRECTORY_SELECT = `
  select u.id, u.username, u.name, u.code, u.role, u.loc_id, u.phone, u.email,
         u.dob, u.scope, u.lead_name, u.lead_phone, u.lead_email, u.backup_id,
         u.leave, u.add_tabs, u.no_tabs, u.active, u.created_at,
         coalesce((select array_agg(d.dept order by d.dept)
                   from user_departments d where d.user_id = u.id), '{}') as depts,
         coalesce((select jsonb_object_agg(p.perm, p.granted)
                   from user_permissions p where p.user_id = u.id), '{}'::jsonb) as overrides,
         (select count(*) from clients c where c.owner_id = u.id)::int as accounts
  from users u`;

async function loadDirectory(id) {
  const { rows } = await query(`${DIRECTORY_SELECT} where u.id = $1`, [id]);
  return rows[0] || null;
}

// Validate a 4–6 digit PIN. (Legacy asked for 6; the dev seed uses 4, so the
// backend accepts 4–6 rather than locking the seeded master out.)
function pinError(pin) {
  if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4 to 6 digits.';
  return null;
}

// Guard the "nobody hands out a right they do not hold themselves, and nobody
// widens their own rights" rules (legacy saveUser). `actor` is req.user, who by
// this point already holds user.manage. Returns an error string or null.
function overrideGuard(actor, targetId, overrides, scope) {
  if (actor.role === 'master') return null; // past every check
  const keys = Object.keys(overrides || {});
  // You may only pass on rights you hold yourself.
  const beyond = keys.filter((k) => overrides[k] && !can(actor, k));
  if (beyond.length) {
    return `You can only pass on rights you hold yourself — ${beyond.slice(0, 3).join(', ')} is not yours to give.`;
  }
  // Editing yourself: no self-elevation, no widening your own scope.
  if (targetId && targetId === actor.id) {
    const grabbed = keys.filter((k) => overrides[k] && !can(actor, k));
    if (grabbed.length) return 'You cannot give yourself rights you do not have. Ask the master.';
    if (scope && scope !== (actor.scope || (ROLE_DEFAULTS[actor.role] || {}).scope || 'own')) {
      return 'You cannot widen what you can see. Ask the master.';
    }
  }
  return null;
}

// Replace a user's department rows inside an open transaction.
async function setDepts(c, id, depts) {
  await c.query('delete from user_departments where user_id = $1', [id]);
  for (const dept of depts || []) {
    await c.query('insert into user_departments (user_id, dept) values ($1,$2)', [id, dept]);
  }
}

// Replace a user's permission overrides inside an open transaction.
async function setOverrides(c, id, overrides) {
  await c.query('delete from user_permissions where user_id = $1', [id]);
  for (const [perm, granted] of Object.entries(overrides || {})) {
    await c.query(
      'insert into user_permissions (user_id, perm, granted) values ($1,$2,$3)',
      [id, perm, !!granted]
    );
  }
}

// GET /users  — directory. Visible to anyone signed in (owner selects etc.).
userRoutes.get(
  '/',
  wrap(async (req, res) => {
    const { rows } = await query(`${DIRECTORY_SELECT} order by u.name`);
    res.json(rows);
  })
);

// GET /users/:id  — one full directory row.
userRoutes.get(
  '/:id',
  wrap(async (req, res) => {
    const row = await loadDirectory(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  })
);

// POST /users  — add a person. Needs user.manage.
userRoutes.post(
  '/',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.username || !b.name || !b.role)
      return res.status(400).json({ error: 'username, name and role required' });
    if (!['master', 'manager', 'exec', 'dispatch'].includes(b.role))
      return res.status(400).json({ error: 'invalid role' });
    // Only a master may make somebody a master.
    if (b.role === 'master' && req.user.role !== 'master')
      return res.status(403).json({ error: 'Only a master can make somebody else a master.' });
    if (!b.pin) return res.status(400).json({ error: 'Set a PIN for this user.' });
    const pe = pinError(b.pin);
    if (pe) return res.status(400).json({ error: pe });

    const overrides = b.overrides || {};
    const scope = b.scope || (ROLE_DEFAULTS[b.role] || {}).scope || 'own';
    const guard = overrideGuard(req.user, null, overrides, scope);
    if (guard) return res.status(403).json({ error: guard });

    const id = userId(b.username);
    const exists = await query('select 1 from users where id = $1 or username = $2', [id, String(b.username).toLowerCase()]);
    if (exists.rowCount) return res.status(409).json({ error: 'A user with that username already exists.' });

    await withTransaction(async (c) => {
      await c.query(
        `insert into users
          (id, username, name, code, role, loc_id, phone, email, dob, pin_hash, scope,
           lead_name, lead_phone, lead_email, backup_id, add_tabs, no_tabs, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)`,
        [id, String(b.username).toLowerCase(), b.name, b.code || null, b.role, b.loc_id || null,
         b.phone || null, b.email || null, b.dob || null, hashPin(b.pin), scope,
         b.lead_name || null, b.lead_phone || null, b.lead_email || null, b.backup_id || null,
         JSON.stringify(b.add_tabs || []), JSON.stringify(b.no_tabs || []),
         b.active === undefined ? true : !!b.active]
      );
      await setDepts(c, id, b.depts);
      // A master always holds every right — don't store contradictory overrides.
      await setOverrides(c, id, b.role === 'master' ? {} : overrides);
    });
    res.status(201).json(await loadDirectory(id));
  })
);

// PATCH /users/:id  — edit. Needs user.manage. Pass {pin} to reset the PIN,
// {depts} / {overrides} to replace those sets.
userRoutes.patch(
  '/:id',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const b = req.body || {};
    const target = await loadDirectory(req.params.id);
    if (!target) return res.status(404).json({ error: 'not found' });

    // Only a master may touch a master account, or promote anyone to master.
    if (target.role === 'master' && req.user.role !== 'master')
      return res.status(403).json({ error: 'Only a master can change a master account.' });
    if (b.role === 'master' && req.user.role !== 'master')
      return res.status(403).json({ error: 'Only a master can make somebody else a master.' });

    if (b.pin) {
      const pe = pinError(b.pin);
      if (pe) return res.status(400).json({ error: pe });
    }
    const makingMaster = (b.role || target.role) === 'master';
    if ('overrides' in b || 'scope' in b) {
      const guard = overrideGuard(req.user, req.params.id, b.overrides || target.overrides, b.scope ?? target.scope);
      if (guard) return res.status(403).json({ error: guard });
    }

    const sets = [];
    const params = [];
    const cols = {
      name: b.name, code: b.code, role: b.role, loc_id: b.loc_id, phone: b.phone,
      email: b.email, dob: b.dob, scope: b.scope, lead_name: b.lead_name,
      lead_phone: b.lead_phone, lead_email: b.lead_email, backup_id: b.backup_id,
      active: b.active,
    };
    for (const [col, val] of Object.entries(cols)) {
      if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    }
    for (const jcol of ['add_tabs', 'no_tabs', 'leave']) {
      if (jcol in b) { params.push(JSON.stringify(b[jcol])); sets.push(`${jcol} = $${params.length}::jsonb`); }
    }
    if (b.pin) { params.push(hashPin(b.pin)); sets.push(`pin_hash = $${params.length}`); }

    await withTransaction(async (c) => {
      if (sets.length) {
        params.push(req.params.id);
        await c.query(`update users set ${sets.join(', ')} where id = $${params.length}`, params);
      }
      if ('depts' in b) await setDepts(c, req.params.id, b.depts);
      // A master holds everything; clear any stored overrides if promoting.
      if ('overrides' in b || makingMaster) {
        await setOverrides(c, req.params.id, makingMaster ? {} : (b.overrides || {}));
      }
    });
    res.json(await loadDirectory(req.params.id));
  })
);

// PUT /users/:id/permissions  { overrides: { "quote.create": true, ... }, scope }
// Replaces this user's per-user permission overrides. Needs user.manage.
userRoutes.put(
  '/:id/permissions',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const b = req.body || {};
    const target = await loadDirectory(req.params.id);
    if (!target) return res.status(404).json({ error: 'not found' });
    if (target.role === 'master' && req.user.role !== 'master')
      return res.status(403).json({ error: 'Only a master can change a master account.' });
    const overrides = b.overrides || {};
    const guard = overrideGuard(req.user, req.params.id, overrides, b.scope);
    if (guard) return res.status(403).json({ error: guard });

    await withTransaction(async (c) => {
      await setOverrides(c, req.params.id, target.role === 'master' ? {} : overrides);
      if (b.scope) await c.query('update users set scope = $1 where id = $2', [b.scope, req.params.id]);
    });
    res.json(await loadDirectory(req.params.id));
  })
);

// DELETE /users/:id  — remove a person. Needs user.manage. Legacy delUser guards.
userRoutes.delete(
  '/:id',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const target = await loadDirectory(req.params.id);
    if (!target) return res.status(404).json({ error: 'not found' });
    if (target.id === req.user.id)
      return res.status(409).json({ error: 'You cannot remove your own account.' });
    if (target.role === 'master' && req.user.role !== 'master')
      return res.status(403).json({ error: 'Only a master can remove a master account.' });
    if (target.accounts > 0)
      return res.status(409).json({
        error: `${target.name} owns ${target.accounts} account${target.accounts === 1 ? '' : 's'}. Transfer them first, or set the user to Disabled.`,
      });
    if (target.role === 'master') {
      const { rows } = await query(`select count(*)::int as n from users where role = 'master'`);
      if (rows[0].n <= 1) return res.status(409).json({ error: 'Keep at least one master account.' });
    }
    await query('delete from users where id = $1', [req.params.id]);
    res.status(204).end();
  })
);
