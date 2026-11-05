import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { authenticate, requirePerm } from '../auth.js';
import { idWith, wrap } from '../lib/util.js';

export const orderRoutes = Router();
orderRoutes.use(authenticate);

async function loadOrder(id) {
  const { rows } = await query('select * from orders where id = $1', [id]);
  const order = rows[0];
  if (!order) return null;
  const [deliveries, amendments, events] = await Promise.all([
    query('select id, at, qty, note, by_name from order_deliveries where order_id = $1 order by at', [id]),
    query('select id, at, from_date, to_date, reason, status, by_name from order_amendments where order_id = $1 order by at', [id]),
    query('select at, by_name, text from order_events where order_id = $1 order by at', [id]),
  ]);
  order.deliveries = deliveries.rows;
  order.amendments = amendments.rows;
  order.events = events.rows;
  return order;
}

// GET /orders  — list. ?status= ?stage= filters.
orderRoutes.get(
  '/',
  wrap(async (req, res) => {
    const params = [];
    let sql = 'select * from orders where 1=1';
    if (req.query.status) {
      params.push(req.query.status);
      sql += ` and status = $${params.length}`;
    }
    if (req.query.stage) {
      params.push(req.query.stage);
      sql += ` and stage = $${params.length}`;
    }
    sql += ' order by created_at desc';
    const { rows } = await query(sql, params);
    res.json(rows);
  })
);

// GET /orders/:id
orderRoutes.get(
  '/:id',
  wrap(async (req, res) => {
    const order = await loadOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    res.json(order);
  })
);

// POST /orders/win  { quote_id, value, promised, priority, note }
// Wins a quote and raises the single order for its offer family.
// Guard: one offer family (same no+fy) may have only one live (non-Cancelled)
// order — the legacy "one job, one order" rule.
orderRoutes.post(
  '/win',
  requirePerm('quote.create'),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.quote_id) return res.status(400).json({ error: 'quote_id required' });
    if (!b.promised) return res.status(400).json({ error: 'promised delivery date required' });

    const quote = (await query('select * from quotes where id = $1', [b.quote_id])).rows[0];
    if (!quote) return res.status(404).json({ error: 'quote not found' });

    // All quote ids in the same offer family (same number, same FY).
    const family = (
      await query('select id from quotes where no = $1 and fy = $2', [quote.no, quote.fy])
    ).rows.map((r) => r.id);

    const live = (
      await query(
        `select id, pi from orders where quote_id = any($1) and status <> 'Cancelled' limit 1`,
        [family]
      )
    ).rows[0];
    if (live) {
      return res.status(409).json({
        error: `offer already has order ${live.pi || live.id} against it — one job, one order`,
      });
    }

    const id = idWith('ORD');
    await withTransaction(async (c) => {
      await c.query(
        `insert into orders
          (id, quote_id, client_id, owner_id, loc_id, value, promised, orig_promised, priority, note, status, stage, created_by, won_ts)
         values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,'Pending','Commercial',$10, now())`,
        [id, quote.id, quote.client_id, quote.user_id, quote.loc_id, b.value || 0, b.promised,
         !!b.priority, b.note || '', req.user.id]
      );
      await c.query('update quotes set status = $1 where id = $2', ['Won', quote.id]);
      await c.query('insert into order_events (order_id, by_name, text) values ($1,$2,$3)', [
        id, req.user.name, `Won from offer ${quote.label}. Sent to accounts for the PI.`,
      ]);
      // quote.events is JSONB on the quote row (quote_events table was removed).
      await c.query(
        `update quotes set events = events || $1::jsonb where id = $2`,
        [JSON.stringify([{ at: new Date().toISOString(), by_name: req.user.name, text: 'Marked won — with accounts for PI' }]), quote.id]
      );
    });
    res.status(201).json(await loadOrder(id));
  })
);

// PATCH /orders/:id  — advance stage / change priority / promised date.
// Dispatch-side changes need dispatch.update.
orderRoutes.patch(
  '/:id',
  requirePerm('dispatch.update'),
  wrap(async (req, res) => {
    const b = req.body || {};
    const fields = ['stage', 'status', 'priority', 'promised', 'note', 'pi'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in b) {
        params.push(b[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.id);
    const { rowCount } = await query(`update orders set ${sets.join(', ')} where id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    await query('insert into order_events (order_id, by_name, text) values ($1,$2,$3)', [
      req.params.id, req.user.name, 'Order updated',
    ]);
    res.json(await loadOrder(req.params.id));
  })
);

// POST /orders/:id/deliver  { qty, note } — record a (partial) delivery.
orderRoutes.post(
  '/:id/deliver',
  requirePerm('dispatch.update'),
  wrap(async (req, res) => {
    const order = await loadOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    await query(
      'insert into order_deliveries (order_id, qty, note, by_name) values ($1,$2,$3,$4)',
      [req.params.id, b.qty ?? null, b.note || '', req.user.name]
    );
    res.json(await loadOrder(req.params.id));
  })
);

// POST /orders/:id/cancel  — call the order off (master-style action).
orderRoutes.post(
  '/:id/cancel',
  requirePerm('dispatch.amend'),
  wrap(async (req, res) => {
    const { rowCount } = await query(`update orders set status = 'Cancelled' where id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    await query('insert into order_events (order_id, by_name, text) values ($1,$2,$3)', [
      req.params.id, req.user.name, `Order called off: ${(req.body || {}).reason || 'no reason given'}`,
    ]);
    res.json(await loadOrder(req.params.id));
  })
);
