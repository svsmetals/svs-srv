import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { authenticate } from '../auth.js';
import { canSeeRates, canRate } from '../permissions.js';
import { idWith, wrap } from '../lib/util.js';

export const rateRoutes = Router();
rateRoutes.use(authenticate);

const today = () => new Date().toISOString().slice(0, 10);

// Gate everything behind "may see rates"; writes add a "may edit" check.
rateRoutes.use((req, res, next) => {
  if (!canSeeRates(req.user)) return res.status(403).json({ error: 'forbidden' });
  next();
});
function requireEdit(req, res, next) {
  if (!canRate(req.user)) return res.status(403).json({ error: 'The cost master is the master’s.' });
  next();
}

// Read the submit/lock state from settings.data.rateLock.
async function readLock() {
  const { rows } = await query('select data from settings where id = 1');
  return (rows[0] && rows[0].data && rows[0].data.rateLock) || null;
}

// A rate row shaped for the client. on_date/by_name are aliased to on/by so the
// ported frontend helpers read the same keys the legacy app used.
const ROW = `id, material, form, spec, col, unit, cost, market, note,
             on_date as on, by_name as by, history`;

// GET /rates  — the whole sheet plus its lock state.
rateRoutes.get(
  '/',
  wrap(async (req, res) => {
    const { rows } = await query(`select ${ROW} from rates order by material, spec, col`);
    res.json({ rates: rows, lock: await readLock() });
  })
);

// PUT /rates/cell  — set a single sheet cell's "today" figure (inline editing).
// Body { material, spec, col?, market, unit? }. Upserts by (material, spec, col).
rateRoutes.put(
  '/cell',
  requireEdit,
  wrap(async (req, res) => {
    const lock = await readLock();
    if (lock && lock.on) {
      return res.status(409).json({ error: 'The sheet was submitted — open it for editing first.' });
    }
    const b = req.body || {};
    const material = String(b.material || '').trim();
    const spec = String(b.spec || '');
    const col = String(b.col || '');
    const unit = String(b.unit || 'kg');
    if (!material) return res.status(400).json({ error: 'material required' });

    const n = Number(b.market) || 0;
    if (n < 0) return res.status(400).json({ error: 'A minus rate is not a rate.' });
    if (n > 100000) return res.status(400).json({ error: 'That is not a steel rate — check the figure.' });

    const { rows: ex } = await query(
      'select * from rates where material = $1 and spec = $2 and col = $3',
      [material, spec, col]
    );
    const cur = ex[0];

    if (!cur) {
      // An empty box on a line that was never priced is nothing to store.
      if (!n) return res.json(null);
      const id = idWith('RT');
      const { rows } = await query(
        `insert into rates (id, material, spec, col, unit, cost, market, on_date, by_name, history)
         values ($1,$2,$3,$4,$5,0,$6,$7,$8,'[]'::jsonb)
         returning ${ROW}`,
        [id, material, spec, col, unit, n, today(), req.user.name]
      );
      return res.status(201).json(rows[0]);
    }

    // Keep what it was, so an old offer can still be judged against it.
    let history = Array.isArray(cur.history) ? cur.history : [];
    if (Number(cur.market) !== n) {
      history = history.concat([{
        on: cur.on_date || '', by: cur.by_name || '',
        cost: Number(cur.cost) || 0, market: Number(cur.market) || 0,
      }]).slice(-24);
    }
    const { rows } = await query(
      `update rates set market = $1, unit = $2, on_date = $3, by_name = $4, history = $5::jsonb
       where id = $6 returning ${ROW}`,
      [n, unit, today(), req.user.name, JSON.stringify(history), cur.id]
    );
    res.json(rows[0]);
  })
);

// POST /rates/lock  { on: bool }  — submit (lock) or open the sheet for editing.
rateRoutes.post(
  '/lock',
  requireEdit,
  wrap(async (req, res) => {
    const on = !!(req.body && req.body.on);
    const lock = await withTransaction(async (c) => {
      const { rows } = await c.query('select data from settings where id = 1 for update');
      const data = (rows[0] && rows[0].data) || {};
      data.rateLock = { on, at: new Date().toISOString(), by: req.user.name, date: today() };
      await c.query(
        `insert into settings (id, data) values (1, $1::jsonb)
         on conflict (id) do update set data = excluded.data`,
        [JSON.stringify(data)]
      );
      return data.rateLock;
    });
    res.json(lock);
  })
);

// POST /rates  — put a free-form material on, outside the structured bands.
rateRoutes.post(
  '/',
  requireEdit,
  wrap(async (req, res) => {
    const b = req.body || {};
    const material = String(b.material || '').trim();
    const form = String(b.form || '').trim();
    const spec = String(b.spec || '').trim();
    const unit = String(b.unit || 'kg').trim();
    const note = String(b.note || '').trim();
    const cost = Number(b.cost) || 0;
    const market = Number(b.market) || 0;
    if (!material) return res.status(400).json({ error: 'Which metal? — MS, GI, stainless, copper.' });
    if (!(market > 0)) return res.status(400).json({ error: 'Give what it costs today — that is what a new offer is priced from.' });

    const { rows: twin } = await query(
      'select id from rates where material = $1 and spec = $2 and col = $3',
      [material, spec, '']
    );
    if (twin.length) return res.status(409).json({ error: [material, form, spec].filter(Boolean).join(' · ') + ' is already on the cost master — change that one.' });

    const id = idWith('RT');
    const { rows } = await query(
      `insert into rates (id, material, form, spec, col, unit, cost, market, note, on_date, by_name, history)
       values ($1,$2,$3,$4,'',$5,$6,$7,$8,$9,$10,'[]'::jsonb)
       returning ${ROW}`,
      [id, material, form, spec, unit, cost, market, note, today(), req.user.name]
    );
    res.status(201).json(rows[0]);
  })
);

// PATCH /rates/:id  — change an existing material (figure or details).
rateRoutes.patch(
  '/:id',
  requireEdit,
  wrap(async (req, res) => {
    const { rows: ex } = await query('select * from rates where id = $1', [req.params.id]);
    const cur = ex[0];
    if (!cur) return res.status(404).json({ error: 'not found' });

    const b = req.body || {};
    const material = String(b.material ?? cur.material).trim();
    const form = String(b.form ?? cur.form ?? '').trim();
    const spec = String(b.spec ?? cur.spec ?? '').trim();
    const unit = String(b.unit ?? cur.unit ?? 'kg').trim();
    const note = String(b.note ?? cur.note ?? '').trim();
    const cost = b.cost === undefined ? Number(cur.cost) || 0 : Number(b.cost) || 0;
    const market = b.market === undefined ? Number(cur.market) || 0 : Number(b.market) || 0;
    if (!material) return res.status(400).json({ error: 'Which metal?' });
    if (!(market > 0)) return res.status(400).json({ error: 'Give what it costs today — that is what a new offer is priced from.' });

    let history = Array.isArray(cur.history) ? cur.history : [];
    if (Number(cur.cost) !== cost || Number(cur.market) !== market) {
      history = history.concat([{
        on: cur.on_date || '', by: cur.by_name || '',
        cost: Number(cur.cost) || 0, market: Number(cur.market) || 0,
      }]).slice(-24);
    }
    const { rows } = await query(
      `update rates set material=$1, form=$2, spec=$3, unit=$4, note=$5, cost=$6, market=$7,
         on_date=$8, by_name=$9, history=$10::jsonb
       where id=$11 returning ${ROW}`,
      [material, form, spec, unit, note, cost, market, today(), req.user.name, JSON.stringify(history), cur.id]
    );
    res.json(rows[0]);
  })
);

// DELETE /rates/:id  — take a material off the sheet.
rateRoutes.delete(
  '/:id',
  requireEdit,
  wrap(async (req, res) => {
    const { rowCount } = await query('delete from rates where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  })
);
