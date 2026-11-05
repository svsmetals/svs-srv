import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requirePerm } from '../auth.js';
import { wrap } from '../lib/util.js';
import { DEPTS, DEPT_RIGHTS, DEPT_TABS, deptRightsFor, deptTabsFor } from '../permissions.js';

// "What each department carries" — the office can override, per department, the
// screens and rights a desk gives everybody on it. Overrides live in the
// settings singleton (settings.data.deptRights / deptTabs); anything not
// overridden falls back to the shipped DEPT_RIGHTS / DEPT_TABS defaults.
export const departmentRoutes = Router();
departmentRoutes.use(authenticate);

// Read the settings singleton's data blob, creating the row if absent.
async function loadSettingsData() {
  const { rows } = await query('select data from settings where id = 1');
  if (rows[0]) return rows[0].data || {};
  await query(`insert into settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing`);
  return {};
}

async function saveSettingsData(data) {
  await query(
    `insert into settings (id, data) values (1, $1::jsonb)
     on conflict (id) do update set data = excluded.data`,
    [JSON.stringify(data)]
  );
}

function isEdited(data, dept) {
  return !!((data.deptRights && data.deptRights[dept]) || (data.deptTabs && data.deptTabs[dept]));
}

// GET /departments  — effective config per department, with headcount and
// whether the office has changed it from how it shipped.
departmentRoutes.get(
  '/',
  wrap(async (req, res) => {
    const data = await loadSettingsData();
    const { rows: counts } = await query(
      `select dept, count(*)::int as n from user_departments group by dept`
    );
    const on = Object.fromEntries(counts.map((r) => [r.dept, r.n]));
    const out = DEPTS.map((dept) => ({
      dept,
      tabs: deptTabsFor(dept, data.deptTabs),
      rights: deptRightsFor(dept, data.deptRights),
      on: on[dept] || 0,
      edited: isEdited(data, dept),
    }));
    res.json(out);
  })
);

// PUT /departments/:dept  { tabs: [[key,label],...], rights: ["perm",...] }
// Set the override for one department. Needs user.manage.
departmentRoutes.put(
  '/:dept',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const dept = req.params.dept;
    if (!DEPTS.includes(dept)) return res.status(404).json({ error: 'unknown department' });
    const b = req.body || {};
    const data = await loadSettingsData();
    data.deptTabs = data.deptTabs || {};
    data.deptRights = data.deptRights || {};
    data.deptTabs[dept] = Array.isArray(b.tabs) ? b.tabs : [];
    data.deptRights[dept] = Array.isArray(b.rights) ? b.rights : [];
    await saveSettingsData(data);
    res.json({
      dept,
      tabs: deptTabsFor(dept, data.deptTabs),
      rights: deptRightsFor(dept, data.deptRights),
      edited: true,
    });
  })
);

// DELETE /departments/:dept  — put a department back to how it shipped.
departmentRoutes.delete(
  '/:dept',
  requirePerm('user.manage'),
  wrap(async (req, res) => {
    const dept = req.params.dept;
    const data = await loadSettingsData();
    if (data.deptTabs) delete data.deptTabs[dept];
    if (data.deptRights) delete data.deptRights[dept];
    await saveSettingsData(data);
    res.json({
      dept,
      tabs: DEPT_TABS[dept] || [],
      rights: DEPT_RIGHTS[dept] || [],
      edited: false,
    });
  })
);
