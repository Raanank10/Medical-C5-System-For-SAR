// Real-browser test of medical reinforcement and death-certification requests across devices
// (V2.99.38, docs/GAP_CLOSURE_PLAN.md WP-5, database/051-052). A medic, a PC, a physician and a
// second medic (four browser contexts, so four separate devices) share one fake backend in this
// Node process, the same harness as scripts/browser_pre_evacuation_test.js. The fake mirrors what
// the real server does:
// - sync-log role gating for MEDICAL_REINFORCEMENT_REQUESTED / DOCTOR_DEATH_CERTIFICATION_REQUESTED /
//   MEDICAL_REINFORCEMENT_STATUS_UPDATED / PATIENT_DEATH_CONFIRMED
// - project_medical_resource_request() (database/052): creation keyed by (device, local id); status
//   updates matched by server id from any device, or by the creating device's local id; only
//   pc/cc/chamal/physician/admin change status, a requester may only cancel or change urgency;
//   newest local_timestamp wins; a physician's death confirmation resolves the linked
//   death-certification request
// - RLS (decision D3): pc/cc/chamal/physician/admin see every request, others only their own.
// It proves client behavior only; database/052 itself must be exercised against real Postgres.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_reinforcement_sync_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const PC = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const MEDIC = '11111111-1111-4111-8111-111111111111';
const MEDIC2 = '44444444-4444-4444-8444-444444444444';
const PATIENT = '55555555-5555-4555-8555-555555555555';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'doc@test': { id: DOC, role: 'physician', display_name: 'רופא בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש ראשון' },
  'medic2@test': { id: MEDIC2, role: 'medic', display_name: 'חובש שני' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const READ_ALL = ['pc', 'cc', 'chamal', 'physician', 'admin'];
const STATUS_ROLES = ['pc', 'cc', 'chamal', 'physician', 'admin'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const REQ = 'MEDICAL_REINFORCEMENT_REQUESTED';
const DEATH_REQ = 'DOCTOR_DEATH_CERTIFICATION_REQUESTED';
const STATUS = 'MEDICAL_REINFORCEMENT_STATUS_UPDATED';
const DEATH = 'PATIENT_DEATH_CONFIRMED';
const ALLOWED = { pc: [REQ, DEATH_REQ, STATUS], medic: [REQ, DEATH_REQ, STATUS], physician: [REQ, DEATH_REQ, STATUS, DEATH] };
const RESOURCES = ['one_medic', 'two_medics', 'paramedic', 'doctor_treatment', 'doctor_death_cert', 'urgent_evac', 'routine_evac', 'evac_coordination', 'cat_tourniquets', 'hemostatic_gauze', 'airway_equipment', 'iv_fluids', 'hypothermia_blankets', 'medical_equipment'];
const STATUSES = ['pending', 'acknowledged', 'assigned', 'en_route', 'arrived', 'denied', 'cancelled', 'resolved', 'fulfilled', 'closed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let nextId = 1;

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [PC, MEDIC, MEDIC2].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    patients: [],
    events: [],
    medical_resource_requests: [],
    rejected: [],
  };
}

// Port of project_medical_resource_request() (database/052).
function projectRequest(server, evt, actorId) {
  const u = userById(actorId);
  const p = evt.payload_json || {};
  const hist = (status, urgency, extra) => ({ status, urgency, at: evt.local_timestamp, by_name: u.display_name, by_role: u.role, ...extra });
  if (evt.type === DEATH) {
    if (!evt.patient_id || !['physician', 'admin'].includes(u.role)) return;
    server.medical_resource_requests.filter((r) => r.incident_id === evt.incident_id && r.request_kind === 'death_certification'
      && r.linked_patient_ids.includes(evt.patient_id) && !['arrived', 'resolved', 'cancelled', 'denied', 'closed'].includes(r.status)).forEach((r) => {
      Object.assign(r, { status: 'resolved', status_updated_by_name: u.display_name, status_updated_by_role: u.role });
      r.status_history.push(hist('resolved', r.urgency, { reason: 'death_confirmed' }));
    });
    return;
  }
  const clientId = p.id || p.request_id;
  if (evt.type === REQ || evt.type === DEATH_REQ) {
    if (!clientId || !['medic', 'paramedic', 'pc', 'cc', 'chamal', 'physician', 'admin'].includes(u.role)) return;
    const resource = evt.type === DEATH_REQ ? 'doctor_death_cert' : p.resourceType;
    if (!RESOURCES.includes(resource)) return;
    if (server.medical_resource_requests.some((r) => r.origin_device_id === evt.device_id && r.origin_client_request_id === clientId)) return;
    const urgency = ['immediate', 'high', 'routine'].includes(p.urgency) ? p.urgency : 'high';
    server.medical_resource_requests.push({
      id: `aaaaaaaa-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, incident_id: evt.incident_id,
      request_kind: resource === 'doctor_death_cert' ? 'death_certification' : 'reinforcement', resource_type: resource,
      quantity: 1, urgency, reason_codes: (p.reasonCodes || []).filter((x) => /^[a-z_]{1,40}$/.test(x)),
      linked_patient_ids: (p.linkedPatientIds || []).filter((x) => UUID.test(x)), site_id: p.siteId || null,
      target_location: p.targetLocation || null, free_text: p.freeText || null, auto_generated: !!p.autoGenerated,
      status: 'pending', status_history: [hist('pending', urgency)], requested_by: actorId, requested_by_name: u.display_name,
      requested_by_role: u.role, requested_at: evt.local_timestamp, status_updated_by_name: u.display_name,
      status_updated_by_role: u.role, status_updated_at: evt.local_timestamp, origin_device_id: evt.device_id, origin_client_request_id: clientId,
    });
    return;
  }
  const status = STATUSES.includes(p.status) ? p.status : null;
  const urgency = ['immediate', 'high', 'routine'].includes(p.urgency) ? p.urgency : null;
  if (!status && !urgency) return;
  const row = UUID.test(p.server_request_id || '')
    ? server.medical_resource_requests.find((r) => r.id === p.server_request_id && r.incident_id === evt.incident_id)
    : server.medical_resource_requests.find((r) => r.origin_device_id === evt.device_id && r.origin_client_request_id === clientId && r.incident_id === evt.incident_id);
  if (!row) return;
  if (!(STATUS_ROLES.includes(u.role) || (row.requested_by === actorId && (status || 'cancelled') === 'cancelled'))) return;
  if (Date.parse(row.status_updated_at) > Date.parse(evt.local_timestamp)) return;
  Object.assign(row, { status: status || row.status, urgency: urgency || row.urgency, status_updated_by_name: u.display_name, status_updated_by_role: u.role, status_updated_at: evt.local_timestamp });
  row.status_history.push(hist(row.status, row.urgency));
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    const evt = { ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId };
    server.events.push(evt);
    projectRequest(server, evt, userId);
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
  const visible = (rows) => rows.filter((r) => server.incidents.some((i) => i.id === r.incident_id && canSee(i))).filter(match);
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') return { data: clone(server.incidents.filter((i) => i.status === 'active').map((i) => ({ ...i, patient_count: 0, is_member: server.members.some((m) => m.incident_id === i.id && m.profile_id === u.id) }))), error: null };
    if (req.name === 'join_incident') return { data: { id: p.p_incident_id }, error: null };
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
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
  if (req.table === 'medical_resource_requests') {
    // medical_resource_requests_read (database/052, decision D3).
    const rows = visible(server.medical_resource_requests).filter((r) => READ_ALL.includes(u.role) || r.requested_by === u.id);
    return { data: clone(rows), error: null };
  }
  if (req.table === 'patients') {
    return { data: clone(req.single ? null : visible(server.patients)), error: null };
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

async function pullReq(page) {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullMedicalResourceRequests(id))));
  await page.waitForTimeout(250);
}
const reqs = (page) => page.evaluate(() => reinforcementRequests.filter((r) => r.type !== 'resupply').map((r) => ({ id: r.id, serverId: r.serverId || null, resourceType: r.resourceType, status: r.status, urgency: r.urgency, freeText: r.freeText, linked: r.linkedPatientIds, by: r.requestedByName })));

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

  // 1. Medic marks a casualty "suspected deceased": a death-certification request reaches the server.
  const m1 = await phone();
  await login(m1.page, 'medic@test');
  await enter(m1.page);
  await m1.page.evaluate((pid) => {
    const p = { id: pid, visualId: 'P-DEATH', triage: 'black', patientStatus: 'deceased', siteId: 'SITE_A', location: 'קומה 2', events: [] };
    patients.push(p);
    createDeathCertificationRequest(p);
  }, PATIENT);
  await syncAll(m1.page);
  assert(SERVER.medical_resource_requests.length === 1, `${rel}: the death-certification request must reach the server (got ${JSON.stringify(SERVER.medical_resource_requests)})`);
  const death = SERVER.medical_resource_requests[0];
  assert(death.request_kind === 'death_certification' && death.linked_patient_ids[0] === PATIENT && death.requested_by === MEDIC, `${rel}: the server row must be a death certification linked to the patient`);
  assert(SERVER.events.filter((e) => e.type === 'DOCTOR_CERTIFICATION_REQUESTED').length === 0, `${rel}: the duplicate timeline note must stay local`);
  await pullReq(m1.page);
  let mine = await reqs(m1.page);
  assert(mine.length === 1 && mine[0].serverId === death.id && mine[0].id !== death.id, `${rel}: the medic's own request keeps its local id and learns the server id, not a duplicate (got ${JSON.stringify(mine)})`);

  // 2. PC on another device sees it, and asks for a paramedic.
  const pc = await phone();
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  await pullReq(pc.page);
  let pcReqs = await reqs(pc.page);
  assert(pcReqs.some((r) => r.serverId === death.id && r.resourceType === 'doctor_death_cert' && r.by === 'חובש ראשון'), `${rel}: PC must see the medic's death-certification request (got ${JSON.stringify(pcReqs)})`);
  await pc.page.evaluate(() => createMedicalResourceRequest({ resourceType: 'paramedic', reasonCodes: ['red_patient'], urgency: 'immediate', siteId: 'SITE_A', targetLocation: 'כניסה צפונית', freeText: 'פצוע אדום לכוד', requestedByRole: 'pc' }));
  await syncAll(pc.page);
  const para = SERVER.medical_resource_requests.find((r) => r.resource_type === 'paramedic');
  assert(para && para.requested_by === PC && para.urgency === 'immediate' && para.target_location === 'כניסה צפונית', `${rel}: PC's request must reach the server`);

  // 3. Physician on a third device sees both; the death certification is on the physician's list.
  const doc = await phone();
  await login(doc.page, 'doc@test');
  await enter(doc.page);
  await pullReq(doc.page);
  const docReqs = await reqs(doc.page);
  assert(docReqs.length === 2 && docReqs.some((r) => r.resourceType === 'doctor_death_cert') && docReqs.some((r) => r.resourceType === 'paramedic'), `${rel}: physician must see both requests (got ${JSON.stringify(docReqs)})`);
  const docList = await doc.page.evaluate(() => roleScopedRequests('physician').map((r) => r.resourceType));
  assert(docList.includes('doctor_death_cert') && docList.includes('paramedic'), `${rel}: physician's request list must include the remote requests (got ${docList})`);
  const chain = await doc.page.evaluate(() => renderDeathCertificationChain());
  assert(chain.includes(PATIENT), `${rel}: the physician's death-certification chain must name the remote patient`);

  // 4. Physician acknowledges PC's request from a different device: matched by server id.
  await doc.page.evaluate((id) => updateReinforcementStatus(id, 'acknowledged'), para.id);
  await syncAll(doc.page);
  assert(para.status === 'acknowledged' && para.status_updated_by_role === 'physician', `${rel}: a status change from another device must update the server row (got ${para.status})`);
  await pullReq(pc.page);
  pcReqs = await reqs(pc.page);
  const pcPara = pcReqs.find((r) => r.serverId === para.id);
  assert(pcPara && pcPara.status === 'acknowledged' && pcPara.id !== para.id, `${rel}: PC must see the physician's acknowledgment on its own request (got ${JSON.stringify(pcPara)})`);

  // 5. A status change still waiting in the outbox is not overwritten by an older server row.
  await pc.page.evaluate((id) => { const r = reinforcementRequests.find((x) => x.serverId === id); updateReinforcementStatus(r.id, 'en_route'); }, para.id);
  await pullReq(pc.page);
  pcReqs = await reqs(pc.page);
  assert(pcReqs.find((r) => r.serverId === para.id).status === 'en_route', `${rel}: an unsent local status must win over the pulled one`);
  await syncAll(pc.page);
  assert(para.status === 'en_route', `${rel}: PC's own later status must reach the server by its local id`);

  // 6. The medic may not resolve their own request, but may cancel it.
  await m1.page.evaluate(() => { const r = reinforcementRequests.find((x) => x.resourceType === 'doctor_death_cert'); updateReinforcementStatus(r.id, 'resolved'); });
  await syncAll(m1.page);
  assert(death.status === 'pending', `${rel}: a medic must not resolve a request (got ${death.status})`);
  assert(SERVER.events.filter((e) => e.type === 'MEDICAL_REINFORCEMENT_STATUS_UPDATED' && e.actor_id === MEDIC).length === 1, `${rel}: the refused update still stays in the event log`);
  await pullReq(m1.page);
  mine = await reqs(m1.page);
  assert(mine[0].status === 'pending', `${rel}: after the pull the medic's device must follow the server (got ${mine[0].status})`);

  // 7. Physician confirms the death: the server resolves the request, and the medic sees it.
  await doc.page.evaluate((pid) => saveLocalEvent({ type: 'PATIENT_DEATH_CONFIRMED', patient_id: pid, detail: 'test', payload_json: { patient_id: pid } }), PATIENT);
  await syncAll(doc.page);
  assert(death.status === 'resolved', `${rel}: a physician's death confirmation must resolve the request (got ${death.status})`);
  await pullReq(m1.page);
  mine = await reqs(m1.page);
  assert(mine[0].status === 'resolved', `${rel}: the medic must see the request resolved`);

  // 8. Another medic sees neither request (D3: only command, physicians and the requester).
  const m2 = await phone();
  await login(m2.page, 'medic2@test');
  await enter(m2.page);
  await pullReq(m2.page);
  assert((await reqs(m2.page)).length === 0, `${rel}: a medic must not receive other people's requests`);

  // 9. Text another user typed reaches this phone stripped of markup characters.
  const evil = { ...JSON.parse(JSON.stringify(para)), id: 'bbbbbbbb-0000-4000-8000-000000000001', origin_client_request_id: 'REQ-EVIL', status: 'pending',
    free_text: '<img src=x onerror=window.__xss=1>דחוף', target_location: '"><script>window.__xss=1</script>', requested_by_name: '<b>x</b>' };
  SERVER.medical_resource_requests.push(evil);
  await pullReq(doc.page);
  await doc.page.evaluate(() => goTo('commander'));
  await doc.page.waitForTimeout(200);
  const docPara = (await reqs(doc.page)).find((r) => r.serverId === evil.id);
  assert(!(await doc.page.evaluate(() => window.__xss)), `${rel}: remote text must not run`);
  assert(docPara && !/[<>]/.test(docPara.freeText) && docPara.freeText.includes('דחוף'), `${rel}: remote free text must arrive without markup (got ${JSON.stringify(docPara)})`);

  assert(!SERVER.rejected.length, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...m1.errors, ...pc.errors, ...doc.errors, ...m2.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: reinforcement / death-certification requests cross-device browser test passed`);
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
