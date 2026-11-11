import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { authenticate, requirePerm } from '../auth.js';
import { idWith, wrap } from '../lib/util.js';

export const meetingRoutes = Router();
meetingRoutes.use(authenticate);

// GET /meetings?quote_id=  — meetings for a quote (or all mine / all for master+manager)
meetingRoutes.get(
  '/',
  wrap(async (req, res) => {
    const params = [req.user.id];
    let sql = `select m.*, cl.name as client_name
      from meetings m
      left join clients cl on cl.id = m.client_id
      where (m.user_id = $1 or $2)`;
    params.push(req.user.role === 'master' || req.user.role === 'manager');
    if (req.query.quote_id) {
      params.push(req.query.quote_id);
      sql += ` and m.quote_id = $${params.length}`;
    }
    sql += ' order by m.date asc, m.time asc';
    const { rows } = await query(sql, params);
    res.json(rows);
  })
);

// POST /meetings  — schedule a meeting, append event to linked quote
meetingRoutes.post(
  '/',
  requirePerm('quote.create'),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ error: 'client_id required' });
    if (!b.date) return res.status(400).json({ error: 'date required' });

    const { rows: clientRows } = await query('select name from clients where id = $1', [b.client_id]);
    const clientName = clientRows[0]?.name || null;

    const id = idWith('MT');
    await withTransaction(async (c) => {
      await c.query(
        `insert into meetings
           (id, client_id, client_name, quote_id, user_id, date, time, kind, note, by_name)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, b.client_id, clientName, b.quote_id || null, req.user.id,
         b.date, b.time || null, b.kind || null, b.note || null, req.user.name]
      );
      if (b.quote_id) {
        const event = JSON.stringify([{
          at: new Date().toISOString(),
          by_name: req.user.name,
          text: `Meeting set for ${b.date}${b.note ? ' — ' + b.note : ''}`,
        }]);
        await c.query(
          `update quotes set events = events || $1::jsonb where id = $2`,
          [event, b.quote_id]
        );
      }
    });
    const { rows } = await query('select * from meetings where id = $1', [id]);
    res.status(201).json(rows[0]);
  })
);

// PATCH /meetings/:id  — mark Done or Cancelled
meetingRoutes.patch(
  '/:id',
  wrap(async (req, res) => {
    const { status, outcome } = req.body || {};
    if (!['Done', 'Cancelled'].includes(status))
      return res.status(400).json({ error: 'status must be Done or Cancelled' });
    const { rows } = await query(
      `update meetings set status=$1, outcome=$2, closed_ts=now() where id=$3 returning *`,
      [status, outcome || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  })
);
