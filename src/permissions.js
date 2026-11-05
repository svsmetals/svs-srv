// Permission model, ported verbatim from the legacy app's PERMS / ROLE_DEFAULTS.
// Role defaults live here in code; the DB only stores per-user overrides.

// The 22 named permission flags: [key, title, description].
export const PERMS = [
  ['store.manage', 'Run the stores', 'Raise and close indents, issue material and count stock'],
  ['purchase.record', 'Record what was bought', 'Book a purchase against an indent — supplier, bill, quantity and rate — and take the material in'],
  ['holiday.manage', 'Keep the holiday list', 'Declare festivals and gazetted holidays for the whole works'],
  ['ledger.use', 'Reconcile ledgers', 'Set our ledger against a party statement and find what does not agree'],
  ['fleet.manage', 'Run the company fleet', 'Papers and their expiry, servicing, repairs, tyres and spares'],
  ['qap.issue', 'Issue quality plans', 'Draw up and issue a quality assurance plan against an offer or a work order'],
  ['enquiry.editAny', 'Edit enquiries of others', 'Change stage, value or notes on records they do not own'],
  ['quote.create', 'Make quotations', 'Create and revise offers on the SVS letterhead'],
  ['client.transfer', 'Transfer account ownership', 'Move a client from one executive to another'],
  ['client.delete', 'Delete clients and enquiries', 'Permanently remove records'],
  ['user.manage', 'Manage users', 'Add people, set PINs and rights'],
  ['settings.manage', 'Manage company settings', 'Letterhead, terms, bank details, rate master'],
  ['data.export', 'Export data', 'Download CSV and JSON backups'],
  ['reports.view', 'See team reports', 'Performance of other executives'],
  ['dispatch.view', 'See the dispatch board', 'Pending orders, delivery deadlines and priorities'],
  ['dispatch.update', 'Update dispatch', 'Mark delivered or partly delivered, set priority, raise delay notes'],
  ['dispatch.amend', 'Approve timeline changes', 'Accept or decline a dispatch request to move a delivery date'],
  ['wo.approve', 'Approve work orders', 'Release a work order to production'],
  ['cloud.manage', 'Set up cloud sync', 'Connect a computer to the company Worker, take and restore backups'],
  ['compliance.manage', 'Compliance calendar', 'Keep the monthly GST, TDS, TCS, bank and challan calendar'],
  ['payments.manage', 'Payment follow-up', 'Chase outstanding invoices and record what comes in'],
  ['jd.read', 'Read job descriptions', 'See what any person in the works is trusted with'],
];

// Per-role defaults. `scope` is not a permission flag but controls record
// visibility (all / own-location / own-records).
export const ROLE_DEFAULTS = {
  master: { scope: 'all', 'enquiry.editAny': 1, 'quote.create': 1, 'client.transfer': 1, 'client.delete': 1, 'user.manage': 1, 'settings.manage': 1, 'data.export': 1, 'reports.view': 1, 'dispatch.view': 1, 'dispatch.update': 1, 'dispatch.amend': 1, 'cloud.manage': 1 },
  manager: { scope: 'location', 'enquiry.editAny': 1, 'quote.create': 1, 'client.transfer': 1, 'client.delete': 0, 'user.manage': 0, 'settings.manage': 0, 'data.export': 1, 'reports.view': 1, 'dispatch.view': 1, 'dispatch.update': 0, 'dispatch.amend': 1, 'cloud.manage': 0 },
  exec: { scope: 'own', 'enquiry.editAny': 0, 'quote.create': 1, 'client.transfer': 0, 'client.delete': 0, 'user.manage': 0, 'settings.manage': 0, 'data.export': 0, 'reports.view': 0, 'dispatch.view': 1, 'dispatch.update': 0, 'dispatch.amend': 1, 'cloud.manage': 0 },
  dispatch: { scope: 'all', 'enquiry.editAny': 0, 'quote.create': 0, 'client.transfer': 0, 'client.delete': 0, 'user.manage': 0, 'settings.manage': 0, 'data.export': 1, 'reports.view': 0, 'dispatch.view': 1, 'dispatch.update': 1, 'dispatch.amend': 0, 'cloud.manage': 0 },
};

export const ROLE_LABEL = {
  master: 'Master',
  manager: 'Branch manager',
  exec: 'Sales executive',
  dispatch: 'Works & accounts',
};

// The departments a person can be put on (legacy DEPTS).
export const DEPTS = [
  'Admin', 'Sales', 'Marketing', 'Tendering', 'Accounts', 'Finance', 'HR',
  'Stores', 'Production 1', 'Production 2', 'Quality', 'Planning', 'Dispatch',
  'Jobwork Challan', 'Jobwork Dispatch', 'Billing',
];

// What each department carries by default — the "opening position" the build
// shipped. The office can override these per department (stored in settings);
// anything not overridden falls back to here (legacy DEPT_RIGHTS / DEPT_TABS).
export const DEPT_RIGHTS = {
  Stores: ['store.manage'],
  Compliance: ['compliance.manage'],
  Finance: ['payments.manage', 'ledger.use'],
  Billing: ['payments.manage'],
  Accounts: ['ledger.use'],
  HR: ['holiday.manage'],
};

// Screens a department puts on the bar: [tabKey, label] pairs.
export const DEPT_TABS = {
  Tendering: [['tender', 'Tenders']],
  Accounts: [['pf', 'Pro-Forma']],
  Finance: [['bill', 'Billing'], ['pf', 'Pro-Forma']],
  HR: [['hr', 'People']],
  Stores: [['store', 'Stores']],
  'Production 1': [['wo', 'Work orders']],
  'Production 2': [['prod', 'Production'], ['tool', 'Tool room']],
  Quality: [['qc', 'Quality']],
  Planning: [['plan', 'Planning'], ['wo', 'Work orders']],
  Dispatch: [['slips', 'Dispatch slips']],
  'Jobwork Challan': [['jw', 'Jobwork (Challans)']],
  'Jobwork Dispatch': [['jwd', 'Jobwork dispatch']],
  Billing: [['bill', 'Billing']],
};

// Every screen's display name in one place (legacy TAB_LABELS).
export const TAB_LABELS = {
  cmd: 'Command', day: 'My day', quo: 'Quotations', tender: 'Tenders',
  pf: 'Pro-Forma', bill: 'Billing', pay: 'Payments', hr: 'People', store: 'Stores',
  wo: 'Work orders', prod: 'Production', qc: 'Quality', plan: 'Planning',
  slips: 'Dispatch slips', jw: 'Jobwork (Challans)', jwd: 'Jobwork dispatch',
  disp: 'Order board', cli: 'Clients', team: 'Team', yard: 'Stock yard', fleet: 'Fleet',
  users: 'Users & rights', open: 'Open items', dq: 'Data quality', health: 'Health',
  raw: 'Raw material', cost: 'Cost master', tool: 'Tool room', setup: 'Setup',
  ledger: 'Ledger check', comply: 'Compliance', lead: 'My team', sync: 'Storage & sync',
};

// Effective rights a department carries: the office override if set, else the
// shipped default. `deptOverrides` is settings.data.deptRights ({} if unset).
export function deptRightsFor(dept, deptOverrides) {
  const o = deptOverrides || {};
  return o[dept] || DEPT_RIGHTS[dept] || [];
}

// Effective screens a department gives (override else default).
export function deptTabsFor(dept, deptOverrides) {
  const o = deptOverrides || {};
  return o[dept] || DEPT_TABS[dept] || [];
}

// The set of perms a user picks up purely from their departments, given the
// current dept-rights overrides. Used by loadUser to precompute user.deptPerms.
export function deptPermsOf(depts, deptOverrides) {
  const set = new Set();
  for (const d of depts || []) {
    for (const p of deptRightsFor(d, deptOverrides)) set.add(p);
  }
  return set;
}

// Does `user` hold `perm`? Masters bypass all checks (same as the legacy app).
// Precedence mirrors the legacy can(): a department-carried right is additive
// and cannot be revoked for one person (the office takes it off the whole
// desk), so it wins over a per-user "off". Otherwise an explicit per-user
// decision (override) is authoritative, and failing that the role default
// applies. `user.deptPerms` is the precomputed set from loadUser.
export function can(user, perm) {
  if (!user) return false;
  if (user.role === 'master') return true;
  const has = user.overrides && Object.prototype.hasOwnProperty.call(user.overrides, perm);
  if (has && user.overrides[perm]) return true;           // granted by hand
  if (user.deptPerms && user.deptPerms.has && user.deptPerms.has(perm)) return true; // from a department
  if (has && !user.overrides[perm]) return false;         // deliberately taken off
  return (ROLE_DEFAULTS[user.role] || {})[perm] === 1;    // role default
}

// The record-visibility scope for a user: 'all' | 'location' | 'own'.
// Stored on the users.scope column; falls back to the role default.
export function scopeOf(user) {
  if (!user) return 'own';
  if (user.scope) return user.scope;
  if (user.overrides && user.overrides.scope) return user.overrides.scope;
  return (ROLE_DEFAULTS[user.role] || {}).scope || 'own';
}
