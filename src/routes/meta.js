import { Router } from 'express';
import { authenticate, requirePerm } from '../auth.js';
import { query } from '../db.js';
import { wrap } from '../lib/util.js';
import {
  PERMS, ROLE_LABEL, ROLE_DEFAULTS, DEPTS, TAB_LABELS, DEPT_RIGHTS, DEPT_TABS,
} from '../permissions.js';

export const metaRoutes = Router();
metaRoutes.use(authenticate);

metaRoutes.get(
  '/',
  wrap(async (req, res) => {
    res.json({
      perms: PERMS,
      roleLabels: ROLE_LABEL,
      roleDefaults: ROLE_DEFAULTS,
      depts: DEPTS,
      tabLabels: TAB_LABELS,
      deptRightsDefault: DEPT_RIGHTS,
      deptTabsDefault: DEPT_TABS,
    });
  })
);

// GET /meta/settings  — company + letterhead settings singleton
metaRoutes.get(
  '/settings',
  wrap(async (req, res) => {
    const { rows } = await query('select data from settings where id = 1');
    res.json(rows[0]?.data || {});
  })
);

// PUT /meta/settings  — full replace of settings data (master only)
metaRoutes.put(
  '/settings',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const data = req.body || {};
    await query(
      `insert into settings (id, data) values (1, $1::jsonb)
       on conflict (id) do update set data = excluded.data`,
      [JSON.stringify(data)]
    );
    res.json(data);
  })
);

// GET /meta/quote-seq?fy=26-27  — next offer number for a financial year (master only)
metaRoutes.get(
  '/quote-seq',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const fy = req.query.fy;
    if (!fy) return res.status(400).json({ error: 'fy required' });
    const { rows } = await query('select next_no from quote_sequences where fy = $1', [fy]);
    res.json({ fy, next_no: rows[0]?.next_no ?? 1 });
  })
);

// PUT /meta/quote-seq  { fy, next_no }  — override next offer number (master only)
metaRoutes.put(
  '/quote-seq',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const { fy, next_no } = req.body || {};
    if (!fy) return res.status(400).json({ error: 'fy required' });
    const n = parseInt(next_no, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'next_no must be a positive integer' });
    await query(
      `insert into quote_sequences (fy, next_no) values ($1, $2)
       on conflict (fy) do update set next_no = excluded.next_no`,
      [fy, n]
    );
    res.json({ fy, next_no: n });
  })
);
