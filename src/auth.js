import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query } from './db.js';
import { can, deptPermsOf } from './permissions.js';

// ---------------------------------------------------------------------------
// PIN hashing. Server-side PBKDF2 (the legacy app hashed client-side; here the
// server owns it). Format: pbkdf2$<iterations>$<saltB64>$<hashB64>.
// NOTE for migration: legacy pin hashes use a different, client-side scheme.
// Existing users will need a PIN reset on cutover unless we port that exact
// algorithm — flagged in MIGRATION-PLAN.md.
// ---------------------------------------------------------------------------
const PBKDF2_ITERS = 200000;
const KEYLEN = 32;
const DIGEST = 'sha256';

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(pin), salt, PBKDF2_ITERS, KEYLEN, DIGEST);
  return `pbkdf2$${PBKDF2_ITERS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPin(pin, stored) {
  if (!stored) return false;
  const [scheme, itersStr, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const iters = Number(itersStr);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.pbkdf2Sync(String(pin), salt, iters, expected.length, DIGEST);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------
export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpires,
  });
}

// Load the full user (with permission overrides) by id.
async function loadUser(id) {
  const { rows } = await query(
    'select id, username, name, role, loc_id, scope, active from users where id = $1',
    [id]
  );
  const u = rows[0];
  if (!u || !u.active) return null;
  const { rows: ov } = await query(
    'select perm, granted from user_permissions where user_id = $1',
    [id]
  );
  u.overrides = Object.fromEntries(ov.map((r) => [r.perm, r.granted]));
  // Departments this person is on, and the perms those departments carry (with
  // the office's dept-rights overrides applied), so can() honours dept rights.
  const { rows: dept } = await query(
    'select dept from user_departments where user_id = $1',
    [id]
  );
  u.depts = dept.map((r) => r.dept);
  const { rows: sr } = await query('select data from settings where id = 1');
  const deptOverrides = (sr[0] && sr[0].data && sr[0].data.deptRights) || {};
  u.deptPerms = deptPermsOf(u.depts, deptOverrides);
  return u;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Verifies the Bearer token, loads the user, attaches it to req.user.
export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await loadUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'invalid session' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// Gate a route behind a named permission.
export function requirePerm(perm) {
  return (req, res, next) => {
    if (!can(req.user, perm)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
