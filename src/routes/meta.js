import { Router } from 'express';
import { authenticate } from '../auth.js';
import { wrap } from '../lib/util.js';
import {
  PERMS, ROLE_LABEL, ROLE_DEFAULTS, DEPTS, TAB_LABELS, DEPT_RIGHTS, DEPT_TABS,
} from '../permissions.js';

// Static reference data the Users & rights screen draws from: the permission
// catalogue, role labels/defaults, the department list, every screen's label,
// and what each department carries by default. None of it is secret; it just
// saves the frontend from hard-coding the same tables.
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
