import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requirePerm } from '../auth.js';
import { idWith, wrap } from '../lib/util.js';

export const locationRoutes = Router();
locationRoutes.use(authenticate);

// GET /locations  — branches, each with its headcount. Visible to anyone signed
// in (location selects on the user form, quote headers, etc.).
locationRoutes.get(
  '/',
  wrap(async (req, res) => {
    const { rows } = await query(
      `select l.id, l.name, l.code, l.line, l.addr,
              (select count(*) from users u where u.loc_id = l.id)::int as team
       from locations l order by l.name`
    );
    res.json(rows);
  })
);

// POST /locations  — add a branch. Needs user.manage (set from the Users screen).
locationRoutes.post(
  '/',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Enter a location name.' });
    const id = idWith('L');
    await query(
      'insert into locations (id, name, code, line, addr) values ($1,$2,$3,$4,$5)',
      [id, b.name, b.code || null, b.line || null, b.addr || null]
    );
    const { rows } = await query('select id, name, code, line, addr from locations where id = $1', [id]);
    res.status(201).json(rows[0]);
  })
);

// PATCH /locations/:id  — edit a branch. Needs user.manage.
locationRoutes.patch(
  '/:id',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const b = req.body || {};
    const sets = [];
    const params = [];
    for (const f of ['name', 'code', 'line', 'addr']) {
      if (f in b) { params.push(b[f]); sets.push(`${f} = $${params.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.id);
    const { rowCount } = await query(`update locations set ${sets.join(', ')} where id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    const { rows } = await query('select id, name, code, line, addr from locations where id = $1', [req.params.id]);
    res.json(rows[0]);
  })
);

// DELETE /locations/:id  — remove a branch. Refuses while people are posted to
// it (legacy delLoc). Needs user.manage.
locationRoutes.delete(
  '/:id',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const { rows } = await query('select count(*)::int as n from users where loc_id = $1', [req.params.id]);
    if (rows[0].n > 0)
      return res.status(409).json({ error: 'Move the people at this location elsewhere first.' });
    const { rowCount } = await query('delete from locations where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  })
);
