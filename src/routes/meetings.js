import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../auth.js';
import { idWith } from '../lib/util.js';

export const meetingRoutes = Router();
meetingRoutes.use(authenticate);

// POST /meetings — schedule a new meeting (mirrors legacy saveMeeting()).
meetingRoutes.post('/', async (req, res, next) => {
  try {
    const { client_id, quote_id, date, time, kind, note } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    if (!date)      return res.status(400).json({ error: 'date required' });

    const client = await query('select id, name from clients where id = $1', [client_id]);
    if (!client.rows.length) return res.status(404).json({ error: 'client not found' });

    const id = idWith('MT');
    await query(
      `insert into meetings
         (id, client_id, client_name, quote_id, date, time, kind, note, user_id, by_name, status, ts)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Scheduled',now())`,
      [
        id,
        client_id,
        client.rows[0].name,
        quote_id || null,
        date,
        time || null,
        kind || null,
        note || null,
        req.user.id,
        req.user.name,
      ]
    );
    const row = await query('select * from meetings where id = $1', [id]);
    res.status(201).json(row.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /meetings/:id — mark as Done or Cancelled (mirrors legacy meetingDone()).
meetingRoutes.patch('/:id', async (req, res, next) => {
  try {
    const { status, outcome } = req.body;
    if (!['Done', 'Cancelled'].includes(status))
      return res.status(400).json({ error: 'status must be Done or Cancelled' });

    const result = await query(
      `update meetings set status=$1, outcome=$2, closed_ts=now()
       where id=$3 returning *`,
      [status, outcome || '', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});
