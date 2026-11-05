import { Router } from 'express';
import { query } from '../db.js';
import { signToken, verifyPin } from '../auth.js';
import { authenticate } from '../auth.js';
import { can, PERMS } from '../permissions.js';
import { wrap } from '../lib/util.js';

export const authRoutes = Router();

// POST /auth/login  { username, pin } -> { token, user }
authRoutes.post(
  '/login',
  wrap(async (req, res) => {
    const { username, pin } = req.body || {};
    if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });

    const { rows } = await query(
      'select id, username, name, role, loc_id, pin_hash, active from users where username = $1',
      [String(username).toLowerCase()]
    );
    const user = rows[0];
    // Same response whether the user is missing or the PIN is wrong — don't leak
    // which usernames exist.
    if (!user || !user.active || !verifyPin(pin, user.pin_hash)) {
      return res.status(401).json({ error: 'wrong username or PIN' });
    }

    const token = signToken(user);
    delete user.pin_hash;
    res.json({ token, user });
  })
);

// GET /auth/me -> the signed-in user plus resolved permissions
authRoutes.get(
  '/me',
  authenticate,
  wrap(async (req, res) => {
    const u = req.user;
    const perms = {};
    for (const [key] of PERMS) perms[key] = can(u, key);
    res.json({ user: { id: u.id, username: u.username, name: u.name, role: u.role, loc_id: u.loc_id }, perms });
  })
);
