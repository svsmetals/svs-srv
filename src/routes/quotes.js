import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { authenticate, requirePerm } from '../auth.js';
import { idWith, wrap } from '../lib/util.js';
import { allocateQuoteNumber, quoteLabel } from '../lib/quoteNumbering.js';

export const quoteRoutes = Router();
quoteRoutes.use(authenticate);

// Normalize incoming sub-collections and compute the stored totals. Items keep
// whatever extra keys the client sends (dims/fin/ty/img/…) — only the pricing
// fields are coerced. Returns the JSONB values + totals to persist.
function prepare(body) {
  const items = (body.items || []).map((it) => {
    const kind = it.kind || 'item';
    const base = { ...it, kind };
    if (kind !== 'item') { base.qty = null; base.uom = null; base.rate = null; }
    else {
      base.description = it.description ?? it.desc ?? '';
      base.qty = it.qty === '' || it.qty == null ? null : Number(it.qty);
      base.uom = it.uom ?? null;
      base.rate = it.rate === '' || it.rate == null ? null : Number(it.rate);
    }
    return base;
  });
  const charges = (body.charges || []).map((ch) => ({
    description: ch.description ?? ch.desc ?? '',
    amount: ch.amount === '' || ch.amount == null ? 0 : Number(ch.amount),
  }));
  const notes = body.notes || [];

  const real = items.filter((i) => i.kind === 'item');
  const total = real.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const extra = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const taxable = total + extra;
  const gst = Number(body.gst) || 0;
  const gstAmt = taxable * gst / 100;
  const grand = taxable + gstAmt;

  return {
    items, charges, notes,
    items_count: real.length,
    total, extra, taxable, gst_amt: gstAmt, grand,
  };
}

async function loadQuote(id) {
  const { rows } = await query('select * from quotes where id = $1', [id]);
  const quote = rows[0];
  if (!quote) return null;
  // items/charges/notes/events are JSONB columns — already parsed by pg.
  quote.items = quote.items || [];
  quote.charges = quote.charges || [];
  quote.notes = quote.notes || [];
  quote.events = quote.events || [];
  return quote;
}

function appendEvent(byName, text) {
  return JSON.stringify([{ at: new Date().toISOString(), by_name: byName, text }]);
}

// GET /quotes  — list (summary rows + names + stored totals). ?status= ?client_id=.
quoteRoutes.get(
  '/',
  wrap(async (req, res) => {
    const params = [];
    let sql = `select q.id, q.no, q.rev, q.fy, q.label, q.client_id, q.user_id, q.loc_id,
        q.quote_date, q.status, q.gst, q.created_at,
        q.items_count, q.total as basic_total, q.extra as charges_total, q.grand as grand_total,
        cl.name as client_name, u.name as user_name
      from quotes q
      left join clients cl on cl.id = q.client_id
      left join users u on u.id = q.user_id
      where 1=1`;
    if (req.query.status) {
      params.push(req.query.status);
      sql += ` and q.status = $${params.length}`;
    }
    if (req.query.client_id) {
      params.push(req.query.client_id);
      sql += ` and q.client_id = $${params.length}`;
    }
    sql += ' order by q.created_at desc';
    const { rows } = await query(sql, params);
    res.json(rows);
  })
);

// GET /quotes/:id  — full quote
quoteRoutes.get(
  '/:id',
  wrap(async (req, res) => {
    const quote = await loadQuote(req.params.id);
    if (!quote) return res.status(404).json({ error: 'not found' });
    res.json(quote);
  })
);

// POST /quotes  — create. Draft by default (no number). Pass {send:true} to
// allocate an offer number immediately. Needs quote.create.
quoteRoutes.post(
  '/',
  requirePerm('quote.create'),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ error: 'client_id required' });
    const fy = b.fy || null;
    const send = !!b.send;
    if (send && !fy) return res.status(400).json({ error: 'fy required to send a quote' });

    const id = idWith('Q');
    const p = prepare(b);
    await withTransaction(async (c) => {
      let no = null;
      let label = null;
      let status = 'Draft';
      if (send) {
        no = await allocateQuoteNumber(c, fy);
        label = quoteLabel(no, fy);
        status = 'Sent';
      }
      const events = [{ at: new Date().toISOString(), by_name: req.user.name, text: send ? `Created and sent as ${label}` : 'Draft created' }];
      await c.query(
        `insert into quotes
          (id, no, rev, fy, label, client_id, user_id, loc_id, enquiry_id, quote_date, validity, gst, status, follow_up,
           items, charges, notes, events, items_count, total, extra, taxable, gst_amt, grand)
         values ($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           $14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23)`,
        [id, no, fy, label, b.client_id, b.user_id || req.user.id, b.loc_id || req.user.loc_id,
         b.enquiry_id || null, b.quote_date || null, b.validity || null, b.gst ?? null, status, b.follow_up || null,
         JSON.stringify(p.items), JSON.stringify(p.charges), JSON.stringify(p.notes), JSON.stringify(events),
         p.items_count, p.total, p.extra, p.taxable, p.gst_amt, p.grand]
      );
    });
    res.status(201).json(await loadQuote(id));
  })
);

// PATCH /quotes/:id  — edit a draft (fields + sub-collections). Needs quote.create.
quoteRoutes.patch(
  '/:id',
  requirePerm('quote.create'),
  wrap(async (req, res) => {
    const b = req.body || {};
    const existing = await loadQuote(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const sets = [];
    const params = [];
    for (const f of ['client_id', 'user_id', 'loc_id', 'quote_date', 'validity', 'gst', 'follow_up']) {
      if (f in b) { params.push(b[f]); sets.push(`${f} = $${params.length}`); }
    }
    // If any sub-collection is present, recompute + rewrite all of them + totals.
    if ('items' in b || 'charges' in b || 'notes' in b) {
      const merged = {
        items: b.items ?? existing.items,
        charges: b.charges ?? existing.charges,
        notes: b.notes ?? existing.notes,
        gst: 'gst' in b ? b.gst : existing.gst,
      };
      const p = prepare(merged);
      params.push(JSON.stringify(p.items)); sets.push(`items = $${params.length}::jsonb`);
      params.push(JSON.stringify(p.charges)); sets.push(`charges = $${params.length}::jsonb`);
      params.push(JSON.stringify(p.notes)); sets.push(`notes = $${params.length}::jsonb`);
      params.push(p.items_count); sets.push(`items_count = $${params.length}`);
      params.push(p.total); sets.push(`total = $${params.length}`);
      params.push(p.extra); sets.push(`extra = $${params.length}`);
      params.push(p.taxable); sets.push(`taxable = $${params.length}`);
      params.push(p.gst_amt); sets.push(`gst_amt = $${params.length}`);
      params.push(p.grand); sets.push(`grand = $${params.length}`);
    }
    if (!sets.length) return res.json(existing);
    params.push(req.params.id);
    await query(`update quotes set ${sets.join(', ')} where id = $${params.length}`, params);
    res.json(await loadQuote(req.params.id));
  })
);

// POST /quotes/:id/send  — allocate a number and mark Sent. Needs quote.create.
quoteRoutes.post(
  '/:id/send',
  requirePerm('quote.create'),
  wrap(async (req, res) => {
    const quote = await loadQuote(req.params.id);
    if (!quote) return res.status(404).json({ error: 'not found' });
    if (quote.status !== 'Draft') return res.status(409).json({ error: `quote is already ${quote.status}` });
    if (!quote.fy) return res.status(400).json({ error: 'quote has no financial year set' });

    await withTransaction(async (c) => {
      const no = await allocateQuoteNumber(c, quote.fy);
      const label = quoteLabel(no, quote.fy);
      await c.query(
        `update quotes set no = $1, label = $2, status = 'Sent', events = events || $3::jsonb where id = $4`,
        [no, label, appendEvent(req.user.name, `Sent as ${label}`), quote.id]
      );
    });
    res.json(await loadQuote(req.params.id));
  })
);

// POST /quotes/:id/status  { status } — Lost / Superseded (Won goes via orders).
quoteRoutes.post(
  '/:id/status',
  requirePerm('quote.create'),
  wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!['Lost', 'Superseded'].includes(status))
      return res.status(400).json({ error: 'status must be Lost or Superseded' });
    const { rowCount } = await query(
      `update quotes set status = $1, events = events || $2::jsonb where id = $3`,
      [status, appendEvent(req.user.name, `Marked ${status}`), req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json(await loadQuote(req.params.id));
  })
);
