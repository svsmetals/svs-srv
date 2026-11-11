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

  // Company settings — letterhead, strip, addresses.
  await pool.query(
    `insert into settings (id, data) values (1, $1::jsonb)
     on conflict (id) do update set data = excluded.data`,
    [JSON.stringify({
      company: {
        name: 'S. V. Metals & Extrusions Pvt. Ltd.',
        strip: 'Cable Trays | Cable Lugs | Glands | Earthing | Solar | Steel Fabrication | Storage Racks',
        regoff: 'Reg.Off./Unit 1 : A-2/1, Dist, UPSIDA Industrial Area, Kosi, Kotwan, Uttar Pradesh 281403',
        unit2: 'Unit 2 : Gr. Noida',
        certL: '', certImgL: '', certR: '', certImgR: '',
        billName: 'S. V. Metals & Extrusions Pvt. Ltd.',
        billAddr: 'A-2/1, UPSIDA, Kosi Kotwan, UP 281403',
        gstin: '09AAMCS6918C2Z2',
        bankAcc: '9748779148',
        bankIfsc: 'KKBK0005304',
      },
      quote: {
        terms: {
          'Freight': 'Extra as per actual',
          'HSN Code': 'Cable Trays & Steel Fabrication (73089090); GI Earthing Strips (72122020); Lugs (85369090); Glands (85389000)',
          'Accessories': 'Two pieces of Coupler Plates shall be provided FREE OF COST with each piece of MS / GI cable tray.',
          'Jurisdiction': 'Subject to Noida Jurisdiction',
          'Delivery Time': 'Negotiable',
          'Order Initiation': 'In case of advance payment term, manufacturing will start only after receipt of advance payment and manufacturer will not be responsible for the change in rates or delay in delivery.',
          'Holding of Material': 'For whatsoever reason, if the Buyer fails to pick up material within 1 week of Material Readiness intimation, Buyer will be liable to pay 1% per week from the date of Readiness Intimation. For Buyers availing Credit Facility, the Credit period shall start from the date of Readiness Intimation.',
        },
      },
      teamLead: { name: '', phone: '' },
    })]
  );

  console.log('Seeded locations L1/L2 and master user.');
  console.log(`  login: username="${MASTER_USERNAME.toLowerCase()}"  pin="${MASTER_PIN}"`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
