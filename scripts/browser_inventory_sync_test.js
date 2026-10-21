// Real-browser test of inventory on the server (V2.99.46, docs/GAP_CLOSURE_PLAN.md WP-9,
// database/061-062, decision D2). Two medics, a PC and a logistics officer (four browser contexts,
// so four devices) share one fake backend in this Node process, the same harness as
// scripts/browser_resupply_decision_sync_test.js. The fake mirrors what the real server does:
// - sync-log role gating for the supply event types (MEDIC_SUPPLY_EVENTS / SUPPLY_LOGISTICS_EVENTS)
// - project_inventory_movement() (database/062): one inventory_ledger_v12 row per
//   INVENTORY_LEDGER_MOVEMENT (never per SUPPLY_CONSUMED), with stock_owner, stock_after and the
//   phone's time; medic bag rows only from medic/paramedic/pc/physician/admin, PC truck rows only
//   from pc/cc/logistics_officer/admin; one row per (device, local event id)
// - inventory_ledger_v12 RLS: incident members read every row.
// Checks: logistics sees the burn rate of both medics together, each medic bag's and the PC
// truck's current stock, nothing counted twice (server + unsent on the same phone), and the PC
// truck's issue on an approved request reaching logistics.
// It proves client behavior only; database/062 itself is exercised against real Postgres.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_inventory_sync_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const MEDIC = '11111111-1111-4111-8111-111111111111';
const PC = '22222222-2222-4222-8222-222222222222';
const CC = '33333333-3333-4333-8333-333333333333';
const LOGO = '44444444-4444-4444-8444-444444444444';
const MEDIC2 = '66666666-6666-4666-8666-666666666666';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש ראשון' },
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'logo@test': { id: LOGO, role: 'logistics_officer', display_name: 'קצין לוגיסטיקה' },
  'medic2@test': { id: MEDIC2, role: 'medic', display_name: 'חובש שני' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const CREATE = ['SUPPLY_REQUEST_CREATED', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC'];
const DECIDE = ['RESUPPLY_APPROVED_FROM_PC_TRUCK', 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC'];
const MOVE = ['SUPPLY_REQUEST_DISPATCHED', 'SUPPLY_REQUEST_IN_TRANSIT', 'SUPPLY_REQUEST_RECEIVED'];
const MEDIC_SUPPLY = ['SUPPLY_REQUEST_CREATED', 'SUPPLY_CONSUMED', 'SUPPLY_USE_CANCELLED', 'INVENTORY_LEDGER_MOVEMENT', 'LOCAL_STOCKOUT_WARNING', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC'];
const LOGISTICS = [...CREATE, ...DECIDE, ...MOVE, 'SUPPLY_CONSUMED', 'SUPPLY_USE_CANCELLED', 'INVENTORY_LEDGER_MOVEMENT', 'LOCAL_STOCKOUT_WARNING'];
const ALLOWED = { medic: MEDIC_SUPPLY, pc: LOGISTICS, cc: LOGISTICS, logistics_officer: LOGISTICS };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let nextId = 1;

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [MEDIC, PC, CC, LOGO, MEDIC2].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    patients: [],
    events: [],
    supply_requests: [],
    ledger: [],
    rejected: [],
  };
}

// Port of project_supply_request_event() (database/059).
function projectSupply(server, evt, actorId) {
  const u = userById(actorId);
  const p = evt.payload_json || {};
  if (CREATE.includes(evt.type)) {
    const clientId = p.id || p.request_id;
    if (!clientId || server.supply_requests.some((r) => r.origin_device_id === evt.device_id && r.origin_client_request_id === clientId)) return;
    server.supply_requests.push({
      id: `aaaaaaaa-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, incident_id: evt.incident_id, requester_id: actorId,
      status: 'requested', request_level: 'medic_to_pc', items_json: p.items || [], notes: p.freeText || null,
      approved_by_pc: null, assigned_runner_name: null, eta_minutes: null, requested_at: evt.local_timestamp,
      updated_at: evt.local_timestamp, origin_device_id: evt.device_id, origin_client_request_id: clientId,
    });
    return;
  }
  if (DECIDE.includes(evt.type) && !['pc', 'cc', 'admin'].includes(u.role)) return;
  const row = UUID.test(p.supply_request_id || '')
    ? server.supply_requests.find((r) => r.id === p.supply_request_id && r.incident_id === evt.incident_id)
    : server.supply_requests.find((r) => r.origin_device_id === evt.device_id && r.origin_client_request_id === (p.id || p.request_id) && r.incident_id === evt.incident_id);
  if (!row) return;
  const at = evt.local_timestamp;
  if (evt.type === 'RESUPPLY_APPROVED_FROM_PC_TRUCK') { if (row.status === 'requested') Object.assign(row, { status: 'approved', approved_by_pc: actorId, updated_at: at }); }
  else if (DECIDE.includes(evt.type)) { if (row.request_level === 'medic_to_pc') Object.assign(row, { request_level: 'pc_to_logo', updated_at: at }); }
  else if (evt.type === 'SUPPLY_REQUEST_DISPATCHED') { if (['requested', 'approved'].includes(row.status)) Object.assign(row, { status: 'dispatched', assigned_runner_name: p.runner_name || row.assigned_runner_name, updated_at: at }); }
  else if (evt.type === 'SUPPLY_REQUEST_RECEIVED') { if (row.status !== 'cancelled') Object.assign(row, { status: 'delivered', updated_at: at }); }
}

const ITEMS = ['tourniquets', 'pressureDressings', 'hemostaticGauze', 'airwayEquipment', 'ivKits', 'blankets', 'batteryPacks'];
const MOVES = { treatment_consumed: 'treatment_consumed', correction_reversed: 'correction', quantity_corrected: 'correction', logistics_manual_received: 'resupply_received', resupply_received: 'resupply_received', pc_truck_issued: 'pc_truck_issued' };
// Port of project_inventory_movement() (database/062).
function projectInventory(server, evt, actorId) {
  if (evt.type !== 'INVENTORY_LEDGER_MOVEMENT') return;
  const p = evt.payload_json || {};
  const delta = Number(p.quantity_delta);
  if (!ITEMS.includes(p.item_type) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 500 || !MOVES[p.movement_type]) return;
  const owner = p.destination_node === 'pc_truck' || p.source_node === 'pc_truck' ? 'pc_truck' : 'medic_bag';
  const role = userById(actorId).role;
  if (owner === 'medic_bag' && !['medic', 'paramedic', 'pc', 'physician', 'admin'].includes(role)) return;
  if (owner === 'pc_truck' && !['pc', 'cc', 'logistics_officer', 'admin'].includes(role)) return;
  if (server.ledger.some((r) => r.device_id === evt.device_id && r.local_event_id === evt.local_event_id)) return;
  const after = Number(p.local_stock_after ?? p.pc_truck_stock_after);
  server.ledger.push({ incident_id: evt.incident_id, actor_id: actorId, item_type: p.item_type, movement_type: MOVES[p.movement_type], quantity_delta: delta,
    stock_owner: owner, stock_after: Number.isInteger(after) ? after : null, device_id: evt.device_id, local_event_id: evt.local_event_id,
    patient_id: null, occurred_at: evt.local_timestamp, created_at: new Date().toISOString(), stock_seq: p.stock_seq == null ? null : String(p.stock_seq) });
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    const evt = { ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId };
    server.events.push(evt);
    projectSupply(server, evt, userId);
    projectInventory(server, evt, userId);
    accepted.push({ local_event_id: e.local_event_id });
  }
  return { accepted, duplicates: [], rejected, blocked_dependency: [], high_risk_flags: [], field_conflicts: [] };
}

function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const match = (row) => Object.entries(req.eq || {}).every(([c, v]) => row[c] === v)
    && Object.entries(req.in || {}).every(([c, v]) => v.includes(row[c]))
    && (req.notNull || []).every((c) => row[c] != null);
  const canSee = (inc) => BLANKET.includes(u.role) || server.members.some((m) => m.incident_id === inc.id && m.profile_id === u.id);
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') return { data: clone(server.incidents.filter((i) => i.status === 'active').map((i) => ({ ...i, patient_count: 0, is_member: server.members.some((m) => m.incident_id === i.id && m.profile_id === u.id) }))), error: null };
    if (req.name === 'join_incident') return { data: { id: p.p_incident_id }, error: null };
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
    if (req.name === 'get_supply_request_queue') {
      const inc = server.incidents.find((i) => i.id === p.p_incident_id);
      if (!inc || !canSee(inc)) return { data: null, error: { message: 'access denied' } };
      return { data: clone(server.supply_requests.filter((r) => r.incident_id === inc.id).reverse()), error: null };
    }
    return { data: null, error: null };
  }
  if (req.table === 'inventory_ledger_v12') {
    // inventory_ledger_v12_read: incident members; newest first, as the client orders it.
    const rows = server.ledger.filter((r) => { const inc = server.incidents.find((i) => i.id === r.incident_id); return inc && canSee(inc); }).filter(match)
      .slice(); // oldest first, the reverse of what the client asks for: it must sort by time and stock_seq itself
    return { data: clone(rows), error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true })).filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const vis = server.incidents.filter((i) => canSee(i) && match(i));
    if (req.op === 'update') return { data: [], error: null };
    const data = req.single ? (vis[0] || null) : vis;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') return { data: null, error: null };
    let vis = server.members.filter((r) => r.profile_id === u.id || ['pc', 'cc'].includes(u.role)).filter(match);
    if (req.limit) vis = vis.slice(0, req.limit);
    return { data: clone(req.single ? (vis[0] || null) : vis), error: null };
  }
  return { data: req.single ? null : [], error: null };
}

// The in-page client: builds each query and sends it to the Node-side server above.
const FAKE_SUPABASE = `
(function(){
  const USERS=${JSON.stringify(USERS)};
  const session=()=>{ try{ return JSON.parse(sessionStorage.getItem('__fake_session')); }catch(e){ return null; } };
  const userId=()=>session()?.user?.id||null;
  function builder(table){
    const q={kind:'from',table,op:'select',eq:{},in:{},notNull:[],single:false,order:null,limit:null,payload:null,ignoreDup:false};
    const b={};
    b.select=()=>b; b.eq=(c,v)=>{ q.eq[c]=v; return b; }; b.in=(c,v)=>{ q.in[c]=v; return b; };
    b.not=(c,op,v)=>{ if(op==='is'&&v===null) q.notNull.push(c); return b; };
    b.order=(c,o)=>{ q.order={c,asc:o?.ascending!==false}; return b; }; b.limit=n=>{ q.limit=n; return b; };
    b.single=()=>{ q.single=true; return b; }; b.maybeSingle=b.single;
    b.update=p=>{ q.op='update'; q.payload=p; return b; };
    b.upsert=(p,o)=>{ q.op='upsert'; q.payload=p; q.ignoreDup=!!o?.ignoreDuplicates; return b; };
    ['gte','gt','lt','lte','neq','is','range','insert','delete'].forEach(m=>{ b[m]=b[m]||(()=>b); });
    b.then=(resolve,reject)=>window.__fakeServer({...q,userId:userId()}).then(resolve,reject);
    return b;
  }
  window.supabase={createClient:()=>({
    auth:{
      signInWithPassword:async({email})=>{ const u=USERS[email]; if(!u) return {data:null,error:{message:'bad'}}; sessionStorage.setItem('__fake_session',JSON.stringify({access_token:'tok-'+u.id,user:{id:u.id}})); return {data:{user:{id:u.id}},error:null}; },
      getSession:async()=>({data:{session:session()},error:null}),
      getUser:async()=>{ const id=userId(); const e=Object.entries(USERS).find(([,u])=>u.id===id); return {data:{user:e?{id,email:e[0]}:null}}; },
      signOut:async()=>{ sessionStorage.removeItem('__fake_session'); return {error:null}; },
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      verifyOtp:async()=>({error:{message:'n/a'}}), updateUser:async()=>({error:null}), resetPasswordForEmail:async()=>({error:null})
    },
    from:t=>builder(t),
    rpc:(name,params)=>window.__fakeServer({kind:'rpc',name,params,userId:userId()})
  })};
})();`;

async function openPhone(context, file) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/functions/v1/sync-log**', (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) });
    const userId = (r.request().headers().authorization || '').replace('Bearer tok-', '');
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(push(SERVER, userId, r.request().postDataJSON())) });
  });
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  if (await page.locator('#pin-gate-setup-panel').isVisible()) {
    await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  } else {
    await page.fill('#pin-gate-unlock-input', PIN); await page.click('#pin-gate-unlock-btn');
  }
  return { page, errors };
}
async function login(page, email) {
  await page.waitForSelector('#screen-login.active', { timeout: 5000 });
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'synthetic');
  await page.click('#login-submit-btn');
  await page.waitForFunction(() => !!currentUser, null, { timeout: 5000 });
  await page.waitForTimeout(400);
}
async function enter(page) {
  await page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await page.waitForTimeout(300);
}
async function syncAll(page) {
  await page.evaluate(async () => { await syncPush(); });
  await page.waitForTimeout(250);
}
async function pullAll(page) {
  // Two rounds: the first discovers remote patients, the second applies their location/evacuation.
  for (let i = 0; i < 2; i++) { await page.evaluate(() => pullProjectedPatientStateAll()); await page.waitForTimeout(350); }
}
let SERVER = null;

async function pullInv(page) {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullIncidentInventory(id))));
  await page.waitForTimeout(200);
}
const use = (page, item, n) => page.evaluate(([item, n]) => { for (let i = 0; i < n; i++) consumeFieldSupply(item, -1, null, 'treatment_consumed', { silentPopup: true, silentWarnings: true, suppressAutoResupply: true }); }, [item, n]);
const burn = (page, item) => page.evaluate((item) => C5Rules.supplyBurnRatePer10Min(incidentConsumptionEvents(), item, Date.now()), item);

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  SERVER = newServer();
  const contexts = [];
  const phone = async () => {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));
    contexts.push(context);
    return openPhone(context, file);
  };

  // 1. Two medics use tourniquets on their own phones; each movement becomes one ledger row.
  const m1 = await phone();
  await login(m1.page, 'medic@test');
  await enter(m1.page);
  await use(m1.page, 'tourniquets', 2);
  await syncAll(m1.page);
  const m2 = await phone();
  await login(m2.page, 'medic2@test');
  await enter(m2.page);
  await use(m2.page, 'tourniquets', 3);
  await syncAll(m2.page);
  const tqRows = SERVER.ledger.filter((r) => r.item_type === 'tourniquets' && r.stock_owner === 'medic_bag');
  assert(tqRows.length === 5, `${rel}: five uses must give five ledger rows, not one per event (got ${tqRows.length})`);
  assert(SERVER.events.filter((e) => e.type === 'SUPPLY_CONSUMED').length === 5, `${rel}: SUPPLY_CONSUMED must reach the server as the audit record`);
  assert(SERVER.rejected.length === 0, `${rel}: no supply event may be rejected (got ${JSON.stringify(SERVER.rejected)})`);

  // 2. Logistics sees both medics: combined burn rate and each bag's current stock.
  const logo = await phone();
  await login(logo.page, 'logo@test');
  await enter(logo.page);
  await pullInv(logo.page);
  assert((await burn(logo.page, 'tourniquets')) === 5, `${rel}: logistics must see the burn rate of both medics together`);
  const holders = await logo.page.evaluate(() => incidentStockHolders().filter((h) => h.item === 'tourniquets').map((h) => ({ owner: h.owner, actor: h.actorId, stock: h.stock })));
  const bag = (id) => holders.find((h) => h.owner === 'medic_bag' && h.actor === id);
  assert(bag(MEDIC)?.stock === 1 && bag(MEDIC2)?.stock === 0, `${rel}: each medic bag's latest count must reach logistics (got ${JSON.stringify(holders)})`);
  const board = await logo.page.evaluate(() => { goTo('logistics'); renderLogisticsOfficer(); return document.getElementById('logistics-consumption-feed')?.innerText || ''; });
  assert(board.includes('מלאי בשטח') && board.includes('ערכת חובש'), `${rel}: the logistics screen must list the field stock from the server`);
  const ctxBurn = await logo.page.evaluate(() => DecisionSupportEngine.forLogistics().recommendations.map((r) => r.source || {}).filter((s) => s.item === 'tourniquets').map((s) => s.burnRate));
  assert(!ctxBurn.length || ctxBurn[0] === 5, `${rel}: the burn prediction must use incident-wide consumption (got ${ctxBurn})`);

  // 3. An unsent use on the same phone is counted once, before and after it is sent.
  await pullInv(m1.page);
  await use(m1.page, 'tourniquets', 1);
  assert((await burn(m1.page, 'tourniquets')) === 6, `${rel}: server uses + this phone's unsent use (got ${await burn(m1.page, 'tourniquets')})`);
  await syncAll(m1.page);
  assert((await burn(m1.page, 'tourniquets')) === 5, `${rel}: right after sending, before the next pull, the sent use is in neither list`);
  await pullInv(m1.page);
  assert((await burn(m1.page, 'tourniquets')) === 6, `${rel}: after the pull, the sent use is counted once`);

  // 4. The PC truck's issue on an approved request reaches logistics as the truck's stock.
  const pc = await phone();
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  const reqId = await pc.page.evaluate(() => createResupplyRequest({ items: [{ item: 'tourniquets', quantity: 2 }], urgency: 'high', reason: 'manual_request' }).id);
  await pc.page.evaluate((id) => updateResupplyStatus(id, 'approved_from_truck'), reqId);
  await syncAll(pc.page);
  const truckRow = SERVER.ledger.find((r) => r.stock_owner === 'pc_truck' && r.actor_id === PC);
  assert(truckRow && truckRow.quantity_delta === -2 && truckRow.stock_after === 18 && truckRow.movement_type === 'pc_truck_issued', `${rel}: the truck's issue must reach the ledger (got ${JSON.stringify(truckRow)})`);
  await pullInv(logo.page);
  const truck = await logo.page.evaluate(() => serverPcTruckStock());
  assert(truck && truck.tourniquets === 18, `${rel}: logistics must see the PC truck's count (got ${JSON.stringify(truck)})`);
  assert((await burn(logo.page, 'tourniquets')) === 6, `${rel}: a truck issue is not field consumption`);

  // 5. A logistics officer cannot write a medic bag: the event is kept, no ledger row.
  const before = SERVER.ledger.length;
  await logo.page.evaluate(() => saveLocalEvent({ type: 'INVENTORY_LEDGER_MOVEMENT', detail: 'test', payload_json: { item_type: 'ivKits', movement_type: 'treatment_consumed', quantity_delta: -1, local_stock_after: 0 } }));
  await syncAll(logo.page);
  assert(SERVER.ledger.length === before, `${rel}: a logistics officer's medic-bag movement must not reach the ledger`);

  const errors = [...m1.errors, ...m2.errors, ...logo.errors, ...pc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: inventory on the server cross-device browser test passed`);
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const file of files) await checkFile(browser, file);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
