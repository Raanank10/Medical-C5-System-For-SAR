// Real-browser test of the PC's resupply decision across devices (V2.99.43, docs/GAP_CLOSURE_PLAN.md
// WP-6, database/059). A medic, a PC, a CC, a logistics officer and a second medic (five browser
// contexts, so five separate devices) share one fake backend in this Node process, the same harness
// as scripts/browser_reinforcement_sync_test.js. The fake mirrors what the real server does:
// - sync-log role gating for the resupply event types (MEDIC_SUPPLY_EVENTS / SUPPLY_LOGISTICS_EVENTS)
// - project_supply_request_event() (database/059): creation keyed by (device, client id); updates
//   resolved by payload_json.supply_request_id first, else by the sending device's own client id;
//   approve / escalate only from pc/cc/admin; approve only from 'requested'; escalate only from
//   request_level 'medic_to_pc'
// - get_supply_request_queue(): every member of the incident reads every row.
// It proves client behavior only; database/059 itself is exercised against real Postgres.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_resupply_decision_sync_test.js
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

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    const evt = { ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId };
    server.events.push(evt);
    projectSupply(server, evt, userId);
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

async function pullQueue(page) {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullSupplyRequestQueue(id))));
  await page.waitForTimeout(250);
}
const pcBoard = (page) => page.evaluate(() => renderPcResupplyBoard());
const ownResupply = (page) => page.evaluate(() => reinforcementRequests.filter((r) => r.type === 'resupply').map((r) => ({ id: r.id, status: r.status })));
const medicRequest = (page, items) => page.evaluate((items) => createResupplyRequest({ items, urgency: 'high', reason: 'manual_request', note: 'חסר בשטח' }).id, items);

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

  // 1. A medic asks for two tourniquets; the request reaches the server.
  const m1 = await phone();
  await login(m1.page, 'medic@test');
  await enter(m1.page);
  const localA = await medicRequest(m1.page, [{ item: 'tourniquets', quantity: 2 }]);
  await syncAll(m1.page);
  assert(SERVER.supply_requests.length === 1, `${rel}: the medic's request must reach the server (got ${JSON.stringify(SERVER.supply_requests)})`);
  const reqA = SERVER.supply_requests[0];

  // 2. The PC, on another device, gets approve / escalate buttons on the shared queue row.
  const pc = await phone();
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  await pullQueue(pc.page);
  let html = await pcBoard(pc.page);
  assert(html.includes(`decideRemoteSupplyRequest('${reqA.id}'`), `${rel}: the PC board must offer a decision on the medic's request`);
  const truckBefore = await pc.page.evaluate(() => pcTruckStock.tourniquets ?? PC_TRUCK_BASELINE.tourniquets);

  // 3. PC approves from the truck: the server row is approved by the PC, the truck is debited once,
  //    and the buttons do not come back while the decision waits in the outbox.
  await pc.page.evaluate(([id, inc]) => decideRemoteSupplyRequest(id, inc, 'approve'), [reqA.id, INC1]);
  await pc.page.evaluate(([id, inc]) => { const row = _supplyRequestQueue[inc].find((r) => r.id === id); row.status = 'requested'; }, [reqA.id, INC1]); // a pull before the push
  html = await pcBoard(pc.page);
  assert(!html.includes(`decideRemoteSupplyRequest('${reqA.id}','${INC1}','approve')`) && html.includes('החלטה ממתינה לשליחה לשרת'), `${rel}: an unsent decision must not offer the same buttons again`);
  await syncAll(pc.page);
  assert(reqA.status === 'approved' && reqA.approved_by_pc === PC && reqA.request_level === 'medic_to_pc', `${rel}: the PC's approval must reach the server row (got ${JSON.stringify(reqA)})`);
  const approveEvt = SERVER.events.find((e) => e.type === 'RESUPPLY_APPROVED_FROM_PC_TRUCK');
  assert(approveEvt && approveEvt.payload_json.supply_request_id === reqA.id, `${rel}: the approval must carry the server request id`);
  const truckAfter = await pc.page.evaluate(() => pcTruckStock.tourniquets);
  assert(truckAfter === truckBefore - 2, `${rel}: the PC truck must be debited once by 2 (before ${truckBefore}, after ${truckAfter})`);

  // 4. The medic's own request follows the decision; the CC and logistics boards show it.
  await pullQueue(m1.page);
  let own = await ownResupply(m1.page);
  assert(own.find((r) => r.id === localA).status === 'approved_from_truck', `${rel}: the medic must see the PC's approval (got ${JSON.stringify(own)})`);
  const cc = await phone();
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await pullQueue(cc.page);
  const ccHtml = await cc.page.evaluate(() => renderCcResupplyCommandBoard());
  assert(ccHtml.includes('אושר מרכב חוג״ד'), `${rel}: the CC board must show the PC's approval`);
  const logo = await phone();
  await login(logo.page, 'logo@test');
  await enter(logo.page);
  await pullQueue(logo.page);
  const logoActions = await logo.page.evaluate(([inc]) => _supplyRequestQueue[inc].map((r) => supplyRequestDispatchActions(r, inc)).join(''), [INC1]);
  assert(logoActions.includes('לא נדרש משלוח לוגיסטי') && !logoActions.includes('showDispatchRunnerModal'), `${rel}: logistics must not be asked to dispatch what the PC truck fills`);

  // 5. PC marks it delivered; the medic sees it delivered.
  await pullQueue(pc.page);
  html = await pcBoard(pc.page);
  assert(html.includes(`decideRemoteSupplyRequest('${reqA.id}','${INC1}','delivered')`), `${rel}: an approved request must offer "delivered" to the PC`);
  await pc.page.evaluate(([id, inc]) => decideRemoteSupplyRequest(id, inc, 'delivered'), [reqA.id, INC1]);
  await syncAll(pc.page);
  assert(reqA.status === 'delivered', `${rel}: the delivery must reach the server (got ${reqA.status})`);
  await pullQueue(m1.page);
  own = await ownResupply(m1.page);
  assert(own.find((r) => r.id === localA).status === 'delivered', `${rel}: the medic must see the delivery`);

  // 6. A second request the PC escalates: logistics sees it at the PC->logistics level and may dispatch.
  const localB = await medicRequest(m1.page, [{ item: 'ivKits', quantity: 1 }]);
  await syncAll(m1.page);
  const reqB = SERVER.supply_requests.find((r) => r.origin_client_request_id === localB && r.requester_id === MEDIC);
  assert(reqB, `${rel}: the second request must reach the server`);
  await pullQueue(pc.page);
  await pc.page.evaluate(([id, inc]) => decideRemoteSupplyRequest(id, inc, 'escalate'), [reqB.id, INC1]);
  await syncAll(pc.page);
  assert(reqB.request_level === 'pc_to_logo' && reqB.status === 'requested', `${rel}: escalation must move the request to the PC->logistics level (got ${JSON.stringify(reqB)})`);
  await pullQueue(logo.page);
  const logoHtml = await logo.page.evaluate(() => { renderLogisticsOfficer(); return document.getElementById('logistics-real-queue')?.innerHTML || ''; });
  assert(logoHtml.includes('חוג״ד ← לוגיסטיקה') && logoHtml.includes(`showDispatchRunnerModal('${reqB.id}'`), `${rel}: logistics must see the escalated request and be able to dispatch it`);
  await pullQueue(m1.page);
  own = await ownResupply(m1.page);
  assert(own.find((r) => r.id === localB).status === 'escalated_to_cc', `${rel}: the medic must see the escalation`);

  // 7. A truck without the item: "approve" escalates instead, and the truck is not debited.
  await pc.page.evaluate(() => { pcTruckStock.blankets = 0; });
  const localC = await medicRequest(m1.page, [{ item: 'blankets', quantity: 3 }]);
  await syncAll(m1.page);
  const reqC = SERVER.supply_requests.find((r) => r.origin_client_request_id === localC && r.requester_id === MEDIC);
  await pullQueue(pc.page);
  await pc.page.evaluate(([id, inc]) => decideRemoteSupplyRequest(id, inc, 'approve'), [reqC.id, INC1]);
  await syncAll(pc.page);
  assert(reqC.status === 'requested' && reqC.request_level === 'pc_to_logo', `${rel}: a missing truck item must escalate, not approve (got ${JSON.stringify(reqC)})`);
  assert(SERVER.events.some((e) => e.type === 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED' && e.payload_json.supply_request_id === reqC.id), `${rel}: the escalation must be recorded as truck-unavailable`);
  assert((await pc.page.evaluate(() => pcTruckStock.blankets)) === 0, `${rel}: an escalated request must not debit the truck`);

  // 8. Only command decides: a medic never gets the buttons, and logistics' approval does not change the row.
  const m2 = await phone();
  await login(m2.page, 'medic2@test');
  await enter(m2.page);
  await pullQueue(m2.page);
  assert(!(await pcBoard(m2.page)).includes('decideRemoteSupplyRequest('), `${rel}: a medic must not get decision buttons`);
  const localD = await medicRequest(m1.page, [{ item: 'pressureDressings', quantity: 1 }]);
  await syncAll(m1.page);
  const reqD = SERVER.supply_requests.find((r) => r.origin_client_request_id === localD && r.requester_id === MEDIC);
  await logo.page.evaluate((id) => saveLocalEvent({ type: 'RESUPPLY_APPROVED_FROM_PC_TRUCK', detail: 'test', payload_json: { supply_request_id: id } }), reqD.id);
  await syncAll(logo.page);
  assert(reqD.status === 'requested', `${rel}: a logistics officer's approval must not change the row (got ${reqD.status})`);
  assert(SERVER.events.some((e) => e.type === 'RESUPPLY_APPROVED_FROM_PC_TRUCK' && e.actor_id === LOGO), `${rel}: the refused event still stays in the event log`);

  // 9. The PC's own request (made on the PC's phone) is decided from the local board, matched by its own id.
  const localE = await medicRequest(pc.page, [{ item: 'airwayEquipment', quantity: 1 }]);
  await syncAll(pc.page);
  // Local ids are per device (REQ-SUP-001 exists on the medic's phone too), so match the requester.
  const reqE = SERVER.supply_requests.find((r) => r.origin_client_request_id === localE && r.requester_id === PC);
  await pullQueue(pc.page);
  html = await pcBoard(pc.page);
  assert(!html.includes(`decideRemoteSupplyRequest('${reqE.id}'`), `${rel}: a request made on this phone must not get a second set of buttons`);
  await pc.page.evaluate((id) => updateResupplyStatus(id, 'approved_from_truck'), localE);
  await syncAll(pc.page);
  assert(reqE.status === 'approved', `${rel}: the local board's approval must reach the server (got ${reqE.status})`);
  assert(SERVER.events.some((e) => e.type === 'RESUPPLY_APPROVED_FROM_PC_TRUCK' && e.payload_json.supply_request_id === reqE.id), `${rel}: the local board must send the server id it has pulled`);

  assert(SERVER.rejected.length === 0, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...m1.errors, ...pc.errors, ...cc.errors, ...logo.errors, ...m2.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: PC resupply decisions cross-device browser test passed`);
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : { channel: 'chromium' });
  try {
    for (const file of files) await checkFile(browser, file);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
