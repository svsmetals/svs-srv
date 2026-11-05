// Seeds the minimum needed to use the API: the two branch locations and one
// master user (who can then create everyone else through the API).
//
// Solves the bootstrap problem — every route requires auth and POST /users
// needs user.manage, so the first master cannot be made through the API.
//
// Usage: npm run seed
// The master PIN comes from SEED_MASTER_PIN (default "1234" — dev only).
import { pool } from '../src/db.js';
import { hashPin } from '../src/auth.js';

const MASTER_USERNAME = process.env.SEED_MASTER_USERNAME || 'master';
const MASTER_NAME = process.env.SEED_MASTER_NAME || 'Master';
const MASTER_PIN = process.env.SEED_MASTER_PIN || '1234';

function userId(username) {
  const u = String(username).toLowerCase();
  let h = 0;
  for (let i = 0; i < u.length; i++) h = ((h << 5) - h + u.charCodeAt(i)) | 0;
  return `U_${u}_${Math.abs(h).toString(36)}`;
}

async function main() {
  // Locations (from the legacy blankDB defaults).
  await pool.query(
    `insert into locations (id, name, code, line, addr) values
       ('L1','Kosi','KSK','Branch | Kosi','A-2/1, UPSIDA Industrial Area, Kosi Kotwan, UP 281403'),
       ('L2','Noida','NOI','Branch | Noida','Unit 2, Greater Noida, Uttar Pradesh')
     on conflict (id) do nothing`
  );

  // Master user.
  const id = userId(MASTER_USERNAME);
  await pool.query(
    `insert into users (id, username, name, role, loc_id, pin_hash, scope, active)
     values ($1,$2,$3,'master','L1',$4,'all',true)
     on conflict (id) do update set pin_hash = excluded.pin_hash, active = true`,
    [id, MASTER_USERNAME.toLowerCase(), MASTER_NAME, hashPin(MASTER_PIN)]
  );

  console.log('Seeded locations L1/L2 and master user.');
  console.log(`  login: username="${MASTER_USERNAME.toLowerCase()}"  pin="${MASTER_PIN}"`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
