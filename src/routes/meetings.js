import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { authenticate, requirePerm } from '../auth.js';
import { idWith, wrap } from '../lib/util.js';

export const meetingRoutes = Router();
meetingRoutes.use(authenticate);

// GET /meetings?quote_id=  — meetings for a quote (or all mine)
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

// POST /meetings  — schedule a meeting
meetingRoutes.post(
  '/',
  requirePerm('quote.create'),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ error: 'client_id required' });
    if (!b.date) return res.status(400).json({ error: 'date required' });
    const id = idWith('MT');
    await withTransaction(async (c) => {
      await c.query(
        `insert into meetings (id, client_id, quote_id, user_id, date, time, kind, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, b.client_id, b.quote_id || null, req.user.id,
         b.date, b.time || null, b.kind || null, b.note || null]
      );
      // Append event to the linked quote if given
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
