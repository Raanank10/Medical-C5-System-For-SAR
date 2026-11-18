// Real-browser test of inventory on the server (V2.99.46, docs/GAP_CLOSURE_PLAN.md WP-9,
// database/061-062, decision D2). Two medics, a PC and a logistics officer (four browser contexts,
// so four devices) share one fake backend in this Node process, the same harness as
// scripts/browser_resupply_decision_sync_test.js. The fake mirrors what the real server does:
// - sync-log role gating for the supply event types (MEDIC_SUPPLY_EVENTS / SUPPLY_LOGISTICS_EVENTS)
// - project_inventory_movement() (database/062): one inventory_ledger_v12 row per
//   INVENTORY_LEDGER_MOVEMENT (never per SUPPLY_CONSUMED), with stock_owner, stock_after and the
//   phone's time; medic bag rows only from medic/paramedic/pc/physician/admin, PC truck rows only
//   from pc/cc/logistics_officer/admin; one row per (device, local event id)
// - inventory_ledger_v12 RLS: incident members read every row, except the logistics officer
//   (database/074), who reads get_incident_stock_movements(): the same rows without the patient.
// Checks: logistics sees the burn rate of both medics together, each medic bag's and the PC
// truck's current stock, nothing counted twice (server + unsent on the same phone), and the PC
// truck's issue on an approved request reaching logistics, and no patient reaching logistics.
// WP-19 (V2.99.73): the fake also enforces events.patient_id like the real table (a uuid that is a
// patient on the server, else the event is refused: live, every medic movement was refused for a
// "draft-..." patient id, 0 ledger rows). Checked: a movement on a saved patient carries its uuid;
// stock used in the New Patient form is sent after PATIENT_CREATED with the new uuid, net per line;
// an abandoned form's stock is sent with no patient; the MSTART / immediate-action tourniquet comes
// after the patient's create; the medic's bag is not refilled by a new patient or a reload, goes below
// 0, and only "התיק חודש" fills it; a movement queued by an older version is repaired, never dropped.
// It proves client behavior only; database/062 itself is exercised against real Postgres.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
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
// sync-log v18 (WP-38): the medic confirms receipt with SUPPLY_REQUEST_RECEIVED.
const MEDIC_SUPPLY = ['SUPPLY_REQUEST_CREATED', 'SUPPLY_CONSUMED', 'SUPPLY_USE_CANCELLED', 'INVENTORY_LEDGER_MOVEMENT', 'LOCAL_STOCKOUT_WARNING', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC', 'SUPPLY_REQUEST_RECEIVED'];
const LOGISTICS = [...CREATE, ...DECIDE, ...MOVE, 'SUPPLY_CONSUMED', 'SUPPLY_USE_CANCELLED', 'INVENTORY_LEDGER_MOVEMENT', 'LOCAL_STOCKOUT_WARNING'];
const ALLOWED = { medic: MEDIC_SUPPLY, pc: LOGISTICS, cc: LOGISTICS, logistics_officer: LOGISTICS };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPLY_FAMILY = new Set([...MEDIC_SUPPLY, ...LOGISTICS]);
const CLINICAL_ROLES = ['medic', 'paramedic', 'pc', 'physician', 'admin'];
const PATIENT_CREATES = ['PATIENT_CREATED', 'QUICK_PATIENT_CREATED'];
const STOCK_TYPES = ['INVENTORY_LEDGER_MOVEMENT', 'SUPPLY_CONSUMED', 'SUPPLY_USE_CANCELLED', 'LOCAL_STOCKOUT_WARNING'];
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
      delivered_at: null, received_at: null, received_by: null, received_items_json: null,
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
  else if (evt.type === 'SUPPLY_REQUEST_RECEIVED') {
    // database/082 (WP-38): delivered by anyone allowed; received only by the requester, first wins;
    // a medic/paramedic marking someone else's request changes nothing.
    if (row.status === 'cancelled') return;
    const own = actorId === row.requester_id;
    if (['medic', 'paramedic'].includes(u.role) && !own) return;
    Object.assign(row, { status: 'delivered', delivered_at: row.delivered_at || at, updated_at: at });
    if (own && !row.received_at) Object.assign(row, { received_at: at, received_by: actorId, received_items_json: Array.isArray(p.received_items) ? p.received_items : null });
  }
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
  // database/062: the payload's patient is kept only when it is a real patient.
  const cand = p.patient_id || p.patient_context || null;
  const patient = cand && UUID.test(cand) && server.patients.some((x) => x.id === cand) ? cand : null;
  server.ledger.push({ incident_id: evt.incident_id, actor_id: actorId, item_type: p.item_type, movement_type: MOVES[p.movement_type], quantity_delta: delta,
    stock_owner: owner, stock_after: Number.isInteger(after) ? after : null, device_id: evt.device_id, local_event_id: evt.local_event_id,
    patient_id: patient, occurred_at: evt.local_timestamp, created_at: new Date().toISOString(), stock_seq: p.stock_seq == null ? null : String(p.stock_seq) });
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    const allowed = SUPPLY_FAMILY.has(e.type) ? (ALLOWED[u?.role] || []).includes(e.type) : CLINICAL_ROLES.includes(u?.role);
    if (!u || !allowed) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    if (PATIENT_CREATES.includes(e.type) && UUID.test(e.patient_id || '') && !server.patients.some((x) => x.id === e.patient_id)) server.patients.push({ id: e.patient_id, incident_id: body.incident_id });
    // events.patient_id is a uuid foreign key to patients(id): a draft id or a visible number fails
    // the insert (live: MALFORMED_EVENT_ENVELOPE, "invalid input syntax for type uuid").
    if (e.patient_id != null && !(UUID.test(e.patient_id) && server.patients.some((x) => x.id === e.patient_id))) {
      rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'MALFORMED_EVENT_ENVELOPE' });
      server.rejected.push({ role: u.role, type: e.type, patient_id: e.patient_id });
      continue;
    }
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
    if (req.name === 'get_incident_stock_movements') {
      // database/074: incident members; every ledger column except patient_id.
      const inc = server.incidents.find((i) => i.id === p.p_incident_id);
      if (!inc || !canSee(inc)) return { data: null, error: { message: 'access denied' } };
      server.stockRpcCalls = (server.stockRpcCalls || 0) + 1;
      return { data: clone(server.ledger.filter((r) => r.incident_id === inc.id).map(({ patient_id, ...rest }) => rest)), error: null };
    }
    return { data: null, error: null };
  }
  if (req.table === 'inventory_ledger_v12') {
    // inventory_ledger_v12_read: incident members, not the logistics officer (database/074).
    if (u.role === 'logistics_officer') return { data: [], error: null };
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
async function unlockAfterReload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-unlock-input', PIN); await page.click('#pin-gate-unlock-btn');
  await page.waitForFunction(() => !!currentUser, null, { timeout: 5000 });
  await page.waitForTimeout(400);
}

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
  // database/074: logistics reads the bags through get_incident_stock_movements(), never the
  // patient each item was used on.
  assert(SERVER.stockRpcCalls > 0, `${rel}: logistics must read the stock through get_incident_stock_movements()`);
  const logoRows = await logo.page.evaluate(() => _incidentInventory[activeInventoryIncidentId()] || []);
  assert(logoRows.length > 0 && logoRows.every((r) => !('patient_id' in r)), `${rel}: no ledger row on the logistics phone may carry a patient (got ${JSON.stringify(logoRows[0])})`);
  assert(!board.includes('ללא פצוע') && !/P\d{3}/.test(board), `${rel}: the logistics consumption feed must not name a patient`);
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

  // 6. WP-19: every stock event from every entry path is stored, with a real patient or none.
  const p = m1.page;
  const bagOf = (page) => page.evaluate(() => ({ ...medicBag() }));
  const stockRows = (fn) => SERVER.ledger.filter((r) => r.actor_id === MEDIC && fn(r));
  const bag0 = await bagOf(p);
  // 6a. New Patient form: bandage, hemostatic ticked, unticked and ticked again, then saved.
  const saved = await p.evaluate(() => {
    if (!siteData.name) siteData.name = 'מוקד בדיקה';
    startNewPatient('extended');
    const draft = state.patientDraftId;
    state.triage = 'yellow'; state.trapStatus = 'not_trapped'; state.injury = 'פגיעת רסיס';
    const chip = () => document.createElement('button');
    toggleChip(chip(), 'bandage');
    const h = chip(); toggleChip(h, 'hemostatic'); toggleChip(h, 'hemostatic'); toggleChip(h, 'hemostatic');
    const heldSent = getOutbox().filter((e) => ['INVENTORY_LEDGER_MOVEMENT', 'SUPPLY_CONSUMED'].includes(e.type) && !e.synced).length;
    savePatient();
    const pt = patients.find((x) => x.tempPatientId === draft);
    return { draft, uuid: pt && pt.id, heldSent };
  });
  assert(saved.uuid && UUID.test(saved.uuid), `${rel}: the form must save a patient with a uuid (got ${JSON.stringify(saved)})`);
  assert(saved.heldSent === 0, `${rel}: stock used in the New Patient form must wait for the save, not go out with a draft id (${saved.heldSent} queued)`);
  await syncAll(p);
  const formRows = stockRows((r) => r.patient_id === saved.uuid);
  const formItems = formRows.map((r) => `${r.item_type}:${r.quantity_delta}`).sort();
  assert(JSON.stringify(formItems) === JSON.stringify(['hemostaticGauze:-1', 'pressureDressings:-1']), `${rel}: the form's stock must reach the ledger once per line, net, with the new patient (got ${JSON.stringify(formItems)})`);
  const order = SERVER.events.map((e) => e.type + ':' + (e.patient_id || ''));
  const createAt = order.findIndex((x) => x.startsWith('PATIENT_CREATED:' + saved.uuid) || x.startsWith('QUICK_PATIENT_CREATED:' + saved.uuid));
  const firstMove = order.findIndex((x) => x === 'INVENTORY_LEDGER_MOVEMENT:' + saved.uuid);
  assert(createAt >= 0 && firstMove > createAt, `${rel}: the form's movements must be sent after the patient's create (create ${createAt}, movement ${firstMove})`);
  // 6b. A later use on the saved patient carries its uuid on the event and the ledger row.
  await p.evaluate((id) => consumeFieldSupply('pressureDressings', -1, id, 'treatment_consumed', { silentPopup: true, silentWarnings: true, suppressAutoResupply: true }), saved.uuid);
  await syncAll(p);
  assert(stockRows((r) => r.patient_id === saved.uuid && r.item_type === 'pressureDressings').length === 2, `${rel}: a use on a saved patient must reach the ledger with that patient`);
  // 6c. An abandoned form: the item left the bag, so it is sent with no patient (owner 2026-11-18).
  const before6c = stockRows((r) => r.item_type === 'blankets').length;
  await p.evaluate(() => { startNewPatient('extended'); toggleChip(document.createElement('button'), 'blanket'); startNewPatient('extended'); });
  await syncAll(p);
  const blanketRows = stockRows((r) => r.item_type === 'blankets');
  assert(blanketRows.length === before6c + 1 && blanketRows[blanketRows.length - 1].patient_id === null && blanketRows[blanketRows.length - 1].quantity_delta === -1, `${rel}: an abandoned form's stock must be sent once with no patient (got ${JSON.stringify(blanketRows)})`);
  // 6d. Immediate-action tourniquet: the movement comes after the patient's create, with its uuid.
  const imm = await p.evaluate(() => { createImmediateInterventionPatient('tourniquet'); return patients[0].id; });
  await syncAll(p);
  assert(stockRows((r) => r.patient_id === imm && r.item_type === 'tourniquets').length === 1, `${rel}: the immediate-action tourniquet must reach the ledger with its patient`);
  // 6e. A movement queued by an older version (draft id / visible number) is repaired, not dropped.
  const queuedBefore = SERVER.ledger.length;
  await p.evaluate(([draft]) => {
    saveLocalEvent({ type: 'INVENTORY_LEDGER_MOVEMENT', detail: 'old', payload_json: { item_type: 'ivKits', movement_type: 'treatment_consumed', quantity_delta: -1, patient_id: draft, local_stock_after: 0, stock_seq: nextLedgerSeq() } });
    saveLocalEvent({ type: 'INVENTORY_LEDGER_MOVEMENT', detail: 'old', payload_json: { item_type: 'ivKits', movement_type: 'treatment_consumed', quantity_delta: -1, patient_id: 'draft-1-unknown', local_stock_after: 0, stock_seq: nextLedgerSeq() } });
  }, [saved.draft]);
  await syncAll(p);
  const repaired = SERVER.ledger.slice(queuedBefore).filter((r) => r.item_type === 'ivKits').map((r) => r.patient_id);
  assert(repaired.length === 2 && repaired.includes(saved.uuid) && repaired.includes(null), `${rel}: older queued movements must be mapped to the saved patient or sent with none (got ${JSON.stringify(repaired)})`);
  // 6f. The bag is on the medic: no refill by a new patient or a reload; below 0 is allowed.
  const bag1 = await bagOf(p);
  assert(bag1.pressureDressings === bag0.pressureDressings - 2 && bag1.hemostaticGauze === bag0.hemostaticGauze - 1 && bag1.blankets === bag0.blankets - 1,
    `${rel}: uses on several patients must all come off the same bag (before ${JSON.stringify(bag0)}, after ${JSON.stringify(bag1)})`);
  await unlockAfterReload(p);
  const bag2 = await bagOf(p);
  assert(JSON.stringify(bag2) === JSON.stringify(bag1), `${rel}: a reload must not refill the bag (before ${JSON.stringify(bag1)}, after ${JSON.stringify(bag2)})`);
  const stored = await p.evaluate(() => { const raw = localStorage.getItem(MEDIC_BAG_KEY) || ''; return { encrypted: raw.includes('"ct"'), plain: raw.includes('pressureDressings') }; });
  assert(stored.encrypted && !stored.plain, `${rel}: the bag must be stored encrypted (${JSON.stringify(stored)})`);
  await enter(p);
  const tqLeft = bag2.tourniquets;
  for (let i = 0; i <= tqLeft; i++) await use(p, 'tourniquets', 1);
  assert((await bagOf(p)).tourniquets === -1, `${rel}: the bag goes below 0, treatment is never blocked`);
  await syncAll(p);
  const lastTq = stockRows((r) => r.item_type === 'tourniquets').pop();
  assert(lastTq.stock_after === -1, `${rel}: the server must see the bag at -1 (got ${JSON.stringify(lastTq)})`);
  // 6g. "התיק חודש" fills the bag back to the starting list and tells the server; not consumption.
  await pullInv(p);
  const burnBefore = await burn(p, 'tourniquets');
  await p.evaluate(() => restockMedicBag());
  await syncAll(p);
  const full = await bagOf(p);
  const baseline = await p.evaluate(() => ({ ...SUPPLY_BASELINE }));
  assert(JSON.stringify(full) === JSON.stringify(baseline), `${rel}: "התיק חודש" must fill the bag (got ${JSON.stringify(full)})`);
  const restock = stockRows((r) => r.movement_type === 'resupply_received' && r.stock_owner === 'medic_bag' && r.item_type === 'tourniquets').pop();
  assert(restock && restock.quantity_delta === baseline.tourniquets + 1 && restock.stock_after === baseline.tourniquets, `${rel}: the restock must reach the ledger (got ${JSON.stringify(restock)})`);
  await pullInv(p);
  assert((await burn(p, 'tourniquets')) === burnBefore, `${rel}: a restock is not consumption`);
  assert(await p.evaluate((id) => Object.keys(medicBags).includes(id), MEDIC), `${rel}: the bag belongs to the signed-in user`);
  // 6h. Nothing refused, and no stock event ever left the phone with a patient that is not a uuid.
  assert(SERVER.rejected.length === 0, `${rel}: no event may be refused (got ${JSON.stringify(SERVER.rejected)})`);
  const bad = SERVER.events.filter((e) => STOCK_TYPES.includes(e.type) && ((e.patient_id != null && !UUID.test(e.patient_id))
    || (e.payload_json?.patient_id != null && !UUID.test(e.payload_json.patient_id)) || /draft-|P\d{3}/.test(String(e.payload_json?.patient_context || ''))));
  assert(bad.length === 0, `${rel}: stock events must carry a uuid patient or none (got ${JSON.stringify(bad.map((e) => [e.type, e.patient_id, e.payload_json]))})`);

  // 7. WP-38 (owner 2026-11-18): a resupply delivered to a medic raises the bag only when the medic
  //    confirms it, by what arrived (partial allowed), once; the PC's "delivered" alone does not.
  const pullQ = (page) => page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullSupplyRequestQueue(id)))).then(() => page.waitForTimeout(200));
  await pullInv(logo.page);
  const burnLogo0 = await burn(logo.page, 'tourniquets');
  const m2bag0 = (await bagOf(m2.page)).tourniquets;
  const localR = await m2.page.evaluate(() => createResupplyRequest({ items: [{ item: 'tourniquets', quantity: 3 }], urgency: 'high', reason: 'manual_request', note: 'נגמרו' }).id);
  await syncAll(m2.page);
  const reqR = SERVER.supply_requests.find((r) => r.requester_id === MEDIC2 && r.origin_client_request_id === localR);
  assert(reqR, `${rel}: the second medic's request must reach the server`);
  // 7a. PC approves from the truck (truck -3) and marks it delivered: the row is delivered, not received.
  await pullQ(pc.page);
  const truck0 = await pc.page.evaluate(() => pcTruckStock.tourniquets);
  await pc.page.evaluate(([id, inc]) => decideRemoteSupplyRequest(id, inc, 'approve'), [reqR.id, INC1]);
  await syncAll(pc.page);
  await pullQ(pc.page);
  await pc.page.evaluate(([id, inc]) => decideRemoteSupplyRequest(id, inc, 'delivered'), [reqR.id, INC1]);
  await syncAll(pc.page);
  assert((await pc.page.evaluate(() => pcTruckStock.tourniquets)) === truck0 - 3, `${rel}: the truck is debited once by 3`);
  assert(reqR.status === 'delivered' && !reqR.received_at, `${rel}: the PC's "delivered" marks the row delivered, not received (got ${JSON.stringify(reqR)})`);
  await pullQ(pc.page);
  const pcOpen = await pc.page.evaluate((inc) => renderRealSupplyQueueRoleSection(inc), INC1);
  assert(pcOpen.includes('ממתין לאישור החובש'), `${rel}: until the medic confirms, the PC board must show the request as waiting for the medic`);
  // 7b. The medic's phone shows it waiting for receipt, with a "received" button; the bag has not moved.
  await pullQ(m2.page);
  const ownR = await m2.page.evaluate((id) => reinforcementRequests.find((r) => r.id === id)?.status, localR);
  assert(ownR === 'awaiting_receipt', `${rel}: the medic must see the delivery as waiting for their confirmation (got ${ownR})`);
  assert((await bagOf(m2.page)).tourniquets === m2bag0, `${rel}: a delivery the medic has not confirmed must not raise the bag`);
  const panel = await m2.page.evaluate(() => renderMedicActionPanel());
  assert(panel.includes(`openResupplyReceiptSheet('${localR}')`) && panel.includes('קיבלתי'), `${rel}: the medic must be offered "קיבלתי" on the incoming request`);
  // 7c. Another medic cannot confirm someone else's request: the event is kept, the row is unchanged.
  await m1.page.evaluate((sid) => saveLocalEvent({ type: 'SUPPLY_REQUEST_RECEIVED', detail: 'forged', payload_json: { supply_request_id: sid, received_items: [{ item: 'tourniquets', quantity: 9 }] } }), reqR.id);
  await syncAll(m1.page);
  assert(!reqR.received_at, `${rel}: another medic's receipt must not mark the request received (got ${JSON.stringify(reqR)})`);
  // 7d. The medic opens the sheet (prefilled 3), corrects to 2 (one did not arrive) and confirms.
  await m2.page.evaluate((id) => openResupplyReceiptSheet(id), localR);
  const pre = await m2.page.evaluate(() => document.querySelector('#receipt-qty-tourniquets')?.textContent);
  assert(pre === '3', `${rel}: the receipt sheet must be prefilled with what was asked (got ${pre})`);
  await m2.page.click('#receipt-minus-tourniquets');
  await m2.page.click('#receipt-confirm-btn');
  assert((await bagOf(m2.page)).tourniquets === m2bag0 + 2, `${rel}: the bag must rise by what arrived, +2 (got ${(await bagOf(m2.page)).tourniquets}, before ${m2bag0})`);
  await syncAll(m2.page);
  const recRows = SERVER.ledger.filter((r) => r.actor_id === MEDIC2 && r.movement_type === 'resupply_received');
  assert(recRows.length === 1 && recRows[0].item_type === 'tourniquets' && recRows[0].quantity_delta === 2 && recRows[0].stock_after === m2bag0 + 2
    && recRows[0].patient_id === null && recRows[0].stock_owner === 'medic_bag', `${rel}: one resupply_received movement into the medic's bag, no patient (got ${JSON.stringify(recRows)})`);
  assert(reqR.received_by === MEDIC2 && JSON.stringify(reqR.received_items_json) === JSON.stringify([{ item: 'tourniquets', quantity: 2 }]), `${rel}: the server row must record the medic's receipt by what arrived (got ${JSON.stringify(reqR)})`);
  // 7e. Once: no second confirmation, no second movement, the button is gone.
  const again = await m2.page.evaluate((id) => confirmResupplyReceipt(id, [{ item: 'tourniquets', quantity: 2 }]), localR);
  await syncAll(m2.page);
  assert(again === false && SERVER.ledger.filter((r) => r.actor_id === MEDIC2 && r.movement_type === 'resupply_received').length === 1, `${rel}: a receipt is confirmed once`);
  assert(!(await m2.page.evaluate(() => renderMedicActionPanel())).includes(`openResupplyReceiptSheet('${localR}')`), `${rel}: a received request must not offer "קיבלתי" again`);
  // 7f. Logistics: the bag's new count, and neither the truck issue nor the receipt is consumption.
  await pullInv(logo.page);
  const m2Holder = (await logo.page.evaluate(() => incidentStockHolders())).find((h) => h.owner === 'medic_bag' && h.actorId === MEDIC2 && h.item === 'tourniquets');
  assert(m2Holder && m2Holder.stock === m2bag0 + 2, `${rel}: logistics must see the medic's bag raised once (got ${JSON.stringify(m2Holder)})`);
  assert((await burn(logo.page, 'tourniquets')) === burnLogo0, `${rel}: the truck issue and the receipt are not counted in the burn rate (before ${burnLogo0}, after ${await burn(logo.page, 'tourniquets')})`);
  // 7g. The PC sees the receipt, partial, and the request leaves the open board.
  await pullQ(pc.page);
  const pcAfter = await pc.page.evaluate(([inc, id]) => ({ open: renderRealSupplyQueueRoleSection(inc), sub: formatSupplyRequestRow(_supplyRequestQueue[inc].find((r) => r.id === id)).sub }), [INC1, reqR.id]);
  assert(!pcAfter.open.includes('ממתין לאישור החובש') && pcAfter.sub.includes('התקבל אצל החובש') && pcAfter.sub.includes('2 מתוך 3'), `${rel}: the PC must see the partial receipt (got ${pcAfter.sub})`);
  assert(SERVER.rejected.length === 0, `${rel}: no WP-38 event may be refused (got ${JSON.stringify(SERVER.rejected)})`);

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
