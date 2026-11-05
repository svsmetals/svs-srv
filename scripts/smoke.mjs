// End-to-end smoke test against a running server (npm run dev in another shell).
// Exercises the core flow: login -> create client -> draft quote -> send -> win -> order.
// Usage: npm run smoke   (set BASE to override the URL)
const BASE = process.env.BASE || 'http://localhost:4000';
const USERNAME = process.env.SEED_MASTER_USERNAME || 'master';
const PIN = process.env.SEED_MASTER_PIN || '1234';

let token = '';
let pass = 0;
let fail = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
  }
}

async function main() {
  console.log(`Smoke testing ${BASE}`);

  const health = await call('GET', '/health');
  check('health', health.status === 200 && health.body?.ok);

  const login = await call('POST', '/auth/login', { username: USERNAME, pin: PIN });
  check('login', login.status === 200 && login.body?.token, login.body);
  token = login.body?.token || '';
  if (!token) return finish();

  const me = await call('GET', '/auth/me');
  check('me is master', me.status === 200 && me.body?.user?.role === 'master', me.body);

  const client = await call('POST', '/clients', {
    name: 'M/s Smoke Test Industries',
    phone: '9876543210',
    type: 'OEM',
    city: 'Noida',
  });
  check('create client', client.status === 201 && client.body?.id, client.body);
  const clientId = client.body?.id;

  const list = await call('GET', '/clients?q=smoke');
  check('list finds client', list.status === 200 && list.body?.some?.((c) => c.id === clientId), list.body);

  const quote = await call('POST', '/quotes', {
    client_id: clientId,
    fy: '26-27',
    gst: 18,
    validity: '3 Days',
    items: [{ kind: 'item', description: 'Cable Tray 150mm', qty: 100, uom: 'Mtr', rate: 250 }],
    notes: ['Rates Ex-Works Kosi Kotwan'],
  });
  check('create draft quote', quote.status === 201 && quote.body?.status === 'Draft', quote.body);
  const quoteId = quote.body?.id;
  check('draft has no number', quote.body?.no === null, quote.body);
  check('quote has 1 item', quote.body?.items?.length === 1, quote.body?.items);

  const sent = await call('POST', `/quotes/${quoteId}/send`);
  check('send allocates number', sent.status === 200 && sent.body?.no > 0 && sent.body?.status === 'Sent', sent.body);

  const won = await call('POST', '/orders/win', {
    quote_id: quoteId,
    value: 25000,
    promised: '2026-12-01',
  });
  check('win creates order', won.status === 201 && won.body?.id && won.body?.stage === 'Commercial', won.body);
  const orderId = won.body?.id;

  const dupe = await call('POST', '/orders/win', { quote_id: quoteId, value: 1, promised: '2026-12-02' });
  check('second win is blocked (one job, one order)', dupe.status === 409, dupe.body);

  const quoteNow = await call('GET', `/quotes/${quoteId}`);
  check('quote marked Won', quoteNow.body?.status === 'Won', quoteNow.body?.status);

  const order = await call('GET', `/orders/${orderId}`);
  check('order has win event', order.body?.events?.length >= 1, order.body?.events);

  // The won quote + order should surface in the client's list aggregates.
  const agg = await call('GET', '/clients?q=smoke');
  const row = agg.body?.find?.((c) => c.id === clientId);
  check('client list has aggregate fields', row && 'offers' in row && 'open' in row && 'order_value' in row, row);
  check('aggregates reflect won quote/order', row && row.offers >= 1 && Number(row.order_value) === 25000, row);

  finish();
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
