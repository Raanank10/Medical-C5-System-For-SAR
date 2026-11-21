// Real-browser test of the PC review of a deteriorating casualty across devices (WP-26,
// database/093, V2.99.84). Two medics, a PC and a CC (four browser contexts, so four separate
// devices) share one fake backend in this Node process, the harness of
// scripts/browser_reinforcement_sync_test.js. The fake mirrors database/052 + 093:
// - a pc_review row is created only by a medic / paramedic / admin, for a patient of the incident
// - 052's status rules (only command changes status, the requester may raise urgency, newest wins),
//   then 093's outcome on 'resolved', delay on 'acknowledged', and the same decision for every other
//   open review of the same casualty
// - RLS (052): command reads every request, others only their own.
// It proves client behavior only; database/093 itself is exercised by scripts/rls_test_093_pc_review.sql.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_pc_review_sync_test.js
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
const CC = '66666666-6666-4666-8666-666666666666';
const P1 = '55555555-5555-4555-8555-000000000001';
const P2 = '55555555-5555-4555-8555-000000000002';
const P3 = '55555555-5555-4555-8555-000000000003';
const P4 = '55555555-5555-4555-8555-000000000004';
const P5 = '55555555-5555-4555-8555-000000000005';
const P6 = '55555555-5555-4555-8555-000000000006';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'doc@test': { id: DOC, role: 'physician', display_name: 'רופא בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש ראשון' },
  'medic2@test': { id: MEDIC2, role: 'medic', display_name: 'חובש שני' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const READ_ALL = ['pc', 'cc', 'chamal', 'physician', 'admin'];
const STATUS_ROLES = ['pc', 'cc', 'chamal', 'physician', 'admin'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const REQ = 'MEDICAL_REINFORCEMENT_REQUESTED';
const DEATH_REQ = 'DOCTOR_DEATH_CERTIFICATION_REQUESTED';
const STATUS = 'MEDICAL_REINFORCEMENT_STATUS_UPDATED';
const DEATH = 'PATIENT_DEATH_CONFIRMED';
const ALLOWED = { pc: [REQ, DEATH_REQ, STATUS], cc: [REQ, DEATH_REQ, STATUS], medic: [REQ, DEATH_REQ, STATUS, 'VITALS_RECORDED'], physician: [REQ, DEATH_REQ, STATUS, DEATH] };
const RESOURCES = ['one_medic', 'two_medics', 'paramedic', 'doctor_treatment', 'doctor_death_cert', 'urgent_evac', 'routine_evac', 'evac_coordination', 'cat_tourniquets', 'hemostatic_gauze', 'airway_equipment', 'iv_fluids', 'hypothermia_blankets', 'medical_equipment'];
const STATUSES = ['pending', 'acknowledged', 'assigned', 'en_route', 'arrived', 'denied', 'cancelled', 'resolved', 'fulfilled', 'closed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let nextId = 1;

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [PC, MEDIC, MEDIC2, CC].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
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
  // database/093: resourceType 'pc_review' from a medic / paramedic / admin, for a patient of the incident.
  if (evt.type === REQ && p.resourceType === 'pc_review') {
    if (!clientId || !['medic', 'paramedic', 'admin'].includes(u.role)) return;
    const linked = (p.linkedPatientIds || []).filter((x) => UUID.test(x) && server.patients.some((pt) => pt.id === x && pt.incident_id === evt.incident_id));
    if (!linked.length) return;
    if (server.medical_resource_requests.some((r) => r.origin_device_id === evt.device_id && r.origin_client_request_id === clientId)) return;
    const urgency = ['immediate', 'high', 'routine'].includes(p.urgency) ? p.urgency : 'high';
    server.medical_resource_requests.push({
      id: `aaaaaaaa-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, incident_id: evt.incident_id, request_kind: 'pc_review', resource_type: 'pc_review',
      quantity: 1, urgency, reason_codes: (p.reasonCodes || []).filter((x) => /^[a-z_]{1,40}$/.test(x)), linked_patient_ids: linked, site_id: p.siteId || null,
      target_location: p.targetLocation || null, free_text: p.freeText || null, auto_generated: false, status: 'pending', status_history: [hist('pending', urgency)],
      requested_by: actorId, requested_by_name: u.display_name, requested_by_role: u.role, requested_at: evt.local_timestamp, status_updated_by_name: u.display_name,
      status_updated_by_role: u.role, status_updated_at: evt.local_timestamp, origin_device_id: evt.device_id, origin_client_request_id: clientId,
      review_outcome: null, snoozed_until: null, snooze_count: 0, last_event_id: evt.local_event_id,
    });
    return;
  }
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
  // database/093, after 052 accepted it: outcome / delay, then every other open review of the casualty.
  if (row.request_kind !== 'pc_review' || !STATUS_ROLES.includes(u.role)) return;
  const last = row.status_history[row.status_history.length - 1];
  let outcome = null; let until = null;
  if (row.status === 'resolved') {
    outcome = ['priority_updated', 'priority_kept', 'senior_requested', 'evac_moved_up'].includes(p.outcome) ? p.outcome : null;
    row.review_outcome = outcome; row.snoozed_until = null; if (outcome) last.outcome = outcome;
  } else if (row.status === 'acknowledged') {
    const t = Date.parse(p.snoozed_until || ''); const at = Date.parse(evt.local_timestamp);
    until = Number.isFinite(t) && t > at && t <= at + 30 * 60000 ? new Date(t).toISOString() : null;
    row.snoozed_until = until; if (until) { row.snooze_count += 1; last.snoozed_until = until; }
  } else row.snoozed_until = null;
  if (!['acknowledged', 'resolved'].includes(row.status)) return;
  server.medical_resource_requests.filter((r) => r !== row && r.incident_id === evt.incident_id && r.request_kind === 'pc_review'
    && r.linked_patient_ids.some((x) => row.linked_patient_ids.includes(x)) && !['arrived', 'resolved', 'cancelled', 'denied', 'closed', 'fulfilled'].includes(r.status)
    && Date.parse(r.status_updated_at) <= Date.parse(evt.local_timestamp)).forEach((r) => {
    Object.assign(r, { status: row.status, review_outcome: row.status === 'resolved' ? outcome : r.review_outcome, snoozed_until: row.status === 'acknowledged' ? until : null,
      snooze_count: r.snooze_count + (row.status === 'acknowledged' && until ? 1 : 0), status_updated_by_name: u.display_name, status_updated_by_role: u.role, status_updated_at: evt.local_timestamp });
    r.status_history.push(hist(row.status, r.urgency, { reason: 'same_patient_review', outcome: outcome || undefined, snoozed_until: until || undefined }));
  });
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
    // 052, plus 093: the incident's medics / paramedics read every pc_review row.
    const rows = visible(server.medical_resource_requests).filter((r) => READ_ALL.includes(u.role) || r.requested_by === u.id || (r.request_kind === 'pc_review' && ['medic', 'paramedic'].includes(u.role)));
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

async function pullReviews(page) {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullPcReviews(id))));
  await page.waitForTimeout(250);
}
const reviews = (page) => page.evaluate(() => pcReviews.map((r) => ({ id: r.id, serverId: r.serverId || null, status: r.status, urgency: r.urgency, outcome: r.outcome, snoozedUntil: r.snoozedUntil, linked: r.linkedPatientIds, by: r.requestedByName })));
const rows = (pid) => SERVER.medical_resource_requests.filter((r) => r.request_kind === 'pc_review' && (!pid || r.linked_patient_ids.includes(pid)));
const VIT = { yellow: { rr: 18, pulse: 96, spo2: 96, avpu: 'A', bp_estimate: 'radial_weak' }, red: { rr: 20, pulse: 110, spo2: 92, avpu: 'A', bp_estimate: 'radial' } };
// A casualty this phone registered (local) and the server row the 093 creation check looks for.
async function addPatient(page, id, visualId, triage, local = true) {
  if (!SERVER.patients.some((p) => p.id === id)) SERVER.patients.push({ id, incident_id: INC1, visual_id: visualId, current_triage: triage, current_status: 'identified' });
  await page.evaluate(({ id, visualId, triage, vit }) => {
    if (patients.some((p) => p.id === id)) return;
    patients.push({ id, visualId, triage, patientStatus: 'stabilizing', siteId: 'SITE_A', location: 'קומה 1', injury: 'רסיסים', events: [], vitals: { ...vit },
      vitalsObserved: { rr: { at: Date.now() - 60000, src: 'sheet' }, pulse: { at: Date.now() - 60000, src: 'sheet' }, spo2: { at: Date.now() - 60000, src: 'sheet' }, avpu: { at: Date.now() - 60000, src: 'sheet' }, bp_estimate: { at: Date.now() - 60000, src: 'sheet' } },
      lastVitalsAt: Date.now() - 60000, vitalsHistory: [], deterioration: [], alert: false, trapStatus: 'not_trapped', createdAt: new Date().toISOString(), lastModifiedAt: new Date().toISOString() });
  }, { id, visualId, triage, vit: VIT[triage] });
}
async function saveVitals(page, id, values) {
  return page.evaluate(async ({ id, values }) => {
    openQuickVitals(id);
    Object.assign(modalVitals, values);
    await saveModalVitals();
    const p = patients.find((x) => x.id === id);
    openPatient(id);
    const body = document.getElementById('detail-body');
    const card = body.querySelector('[data-priority-card]');
    return { rec: p.priorityRecommendation || null, prompt: p.redDeteriorationPrompt || null, alert: p.alert, card: card ? card.dataset.priorityCard : null,
      cardText: card ? card.innerText : '', triage: p.triage };
  }, { id, values });
}
async function clickInCard(page, kind, label) {
  await page.evaluate(({ kind, label }) => {
    const b = [...document.querySelectorAll(`[data-priority-card="${kind}"] button`)].find((x) => x.textContent.trim() === label);
    if (!b) throw new Error(`no button ${label} in ${kind} card`);
    b.click();
  }, { kind, label });
  await page.waitForTimeout(100);
}
const lineFor = (html, pid) => html.split('<div class="cmd-strip-alert').find((x) => x.includes(`data-pc-review="${pid}"`)) || '';
const strip = (page, role) => page.evaluate((role) => renderCommandStatusStrip(role, roleScopedPatients(role), roleAlertRows(role)), role);

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

  // 1. Medic: a yellow casualty gets worse (SpO₂ 96 -> 90): the "worse" card offers the PC review.
  const m1 = await phone();
  await login(m1.page, 'medic@test');
  await enter(m1.page);
  await addPatient(m1.page, P1, 'P001-T', 'yellow');
  let v = await saveVitals(m1.page, P1, { spo2: 90 });
  assert(v.rec && v.rec.direction === 'worse' && v.rec.suggested === 'red' && v.card === 'worse' && v.cardText.includes('בקש חוג"ד'), `${rel}: a worse re-check must show the deterioration card with "בקש חוג"ד" (got ${JSON.stringify(v)})`);
  await clickInCard(m1.page, 'worse', 'בקש חוג"ד');
  await syncAll(m1.page);
  assert(rows(P1).length === 1, `${rel}: the PC review must reach the server (got ${JSON.stringify(SERVER.medical_resource_requests)})`);
  const r1 = rows(P1)[0];
  assert(r1.urgency === 'high' && r1.reason_codes[0] === 'deterioration' && /SpO₂/.test(r1.free_text || '') && r1.requested_by === MEDIC, `${rel}: the row carries urgency, reason and the deterioration (got ${JSON.stringify(r1)})`);
  assert(!SERVER.events.some((e) => e.type === 'PC_REVIEW_REQUESTED_FOR_DETERIORATION'), `${rel}: the timeline note stays local`);
  const counts = await m1.page.evaluate(() => ({ reinf: reinforcementRequests.length, open: reinforcementRequests.filter(isRequestOpen).length }));
  assert(counts.reinf === 0, `${rel}: a PC review is never a reinforcement request (got ${JSON.stringify(counts)})`);

  // 2. A second tap raises it to immediate instead of a second row.
  await addPatient(m1.page, P4, 'P004-T', 'yellow');
  await m1.page.evaluate((id) => { requestPcReview(id, 'manual'); requestPcReview(id, 'manual'); }, P4);
  await syncAll(m1.page);
  assert(rows(P4).length === 1 && rows(P4)[0].urgency === 'immediate' && rows(P4)[0].reason_codes[0] === 'manual', `${rel}: a second tap raises urgency, no duplicate (got ${JSON.stringify(rows(P4))})`);
  assert(rows(P1)[0].urgency === 'high', `${rel}: another casualty's review is not touched`);

  // 3. A red casualty who improves: a neutral "better" card, no PC review, no alert.
  await addPatient(m1.page, P2, 'P002-T', 'red');
  v = await saveVitals(m1.page, P2, { spo2: 98, rr: 16, bp_estimate: 'radial' });
  assert(v.rec && v.rec.direction === 'better' && v.card === 'better' && !v.cardText.includes('חוג"ד') && !v.cardText.includes('הידרדרות') && !v.alert,
    `${rel}: an improvement is not a deterioration: better card, no PC review, no alert (got ${JSON.stringify(v)})`);
  const more = await m1.page.evaluate(() => document.getElementById('detail-bar-more').innerHTML);
  assert(more.includes('data-pc-review-request'), `${rel}: the medic can ask for a PC review by hand from "עוד"`);

  // 4. A red casualty who gets worse and stays red: the red card offers the PC review (immediate).
  await addPatient(m1.page, P3, 'P003-T', 'red');
  v = await saveVitals(m1.page, P3, { spo2: 85 });
  assert(!v.rec && v.prompt && v.card === 'red-worse' && v.cardText.includes('בקש חוג"ד'), `${rel}: a red casualty getting worse must get the red card (got ${JSON.stringify(v)})`);
  await clickInCard(m1.page, 'red-worse', 'בקש חוג"ד');
  await syncAll(m1.page);
  assert(rows(P3).length === 1 && rows(P3)[0].urgency === 'immediate' && rows(P3)[0].reason_codes[0] === 'red_worsening', `${rel}: red worsening is an immediate review (got ${JSON.stringify(rows(P3))})`);

  // 4b. Option B (owner 2026-11-21): a yellow casualty getting worse on two re-checks in a row,
  // still yellow, gets the trend card; one flagged re-check does not; a clean re-check starts over.
  await addPatient(m1.page, P5, 'P005-T', 'yellow');
  v = await saveVitals(m1.page, P5, { pulse: 122 });
  assert(!v.rec && v.triage === 'yellow' && !v.card, `${rel}: one flagged re-check is not a trend (got ${JSON.stringify(v)})`);
  v = await saveVitals(m1.page, P5, { pulse: 148 });
  assert(!v.rec && v.card === 'yellow-trend' && v.cardText.includes('2 בדיקות ברצף') && v.cardText.includes('96→122') && v.cardText.includes('122→148') && v.cardText.includes('בקש חוג"ד'),
    `${rel}: two flagged re-checks in a row show the trend card with both changes (got ${JSON.stringify(v)})`);
  await clickInCard(m1.page, 'yellow-trend', 'המשך מעקב');
  assert(!(await m1.page.evaluate((id) => !!document.querySelector('[data-priority-card="yellow-trend"]') || !!patients.find((p) => p.id === id).yellowTrendPrompt, P5)), `${rel}: "המשך מעקב" hides the card`);
  v = await saveVitals(m1.page, P5, { pulse: 150 });
  assert(!v.card && (await m1.page.evaluate((id) => patients.find((p) => p.id === id).deteriorationStreak, P5)) === 0, `${rel}: a clean re-check starts the count over`);
  v = await saveVitals(m1.page, P5, { pulse: 176 });
  assert(!v.card, `${rel}: after a clean re-check one flag is again not a trend`);
  v = await saveVitals(m1.page, P5, { pulse: 202 });
  assert(v.card === 'yellow-trend' && !v.cardText.includes('96→122'), `${rel}: the trend card comes back with only the new trend (got ${JSON.stringify(v)})`);
  await clickInCard(m1.page, 'yellow-trend', 'בקש חוג"ד');
  await syncAll(m1.page);
  assert(rows(P5).length === 1 && rows(P5)[0].urgency === 'high' && rows(P5)[0].reason_codes[0] === 'yellow_trend' && /150→176/.test(rows(P5)[0].free_text) && /176→202/.test(rows(P5)[0].free_text),
    `${rel}: the trend request reaches the PC with both changes (got ${JSON.stringify(rows(P5))})`);

  // 4c. Breathing rate climbing (14 -> 22 -> 30, still yellow: MSTART red is above 30) is a
  // deterioration flag, so it drives the same trend card. A rise of 6 is not.
  await addPatient(m1.page, P6, 'P006-T', 'yellow');
  await m1.page.evaluate((id) => { const p = patients.find((x) => x.id === id); p.vitals.rr = 14; }, P6);
  v = await saveVitals(m1.page, P6, { rr: 20 });
  assert(!v.card && !(await m1.page.evaluate((id) => patients.find((p) => p.id === id).deterioration.length, P6)), `${rel}: a rise of 6/min is not a flag (got ${JSON.stringify(v)})`);
  v = await saveVitals(m1.page, P6, { rr: 28 });
  assert(v.triage === 'yellow' && !v.card && v.alert, `${rel}: 20 -> 28 is one flag, alert but no trend card yet (got ${JSON.stringify(v)})`);
  v = await saveVitals(m1.page, P6, { rr: 30 });
  assert(!v.card, `${rel}: 28 -> 30 is no flag, the count starts over (got ${JSON.stringify(v)})`);
  await m1.page.evaluate((id) => { const p = patients.find((x) => x.id === id); p.vitals.rr = 14; p.deteriorationStreak = 0; }, P6);
  v = await saveVitals(m1.page, P6, { rr: 22 });
  v = await saveVitals(m1.page, P6, { rr: 30 });
  assert(!v.rec && v.triage === 'yellow' && v.card === 'yellow-trend' && v.cardText.includes('נשימות 14→22') && v.cardText.includes('נשימות 22→30'),
    `${rel}: breathing rate climbing on two re-checks shows the trend card (got ${JSON.stringify(v)})`);

  // 5. A second medic asks about the same casualty: two rows, one line for the PC.
  const m2 = await phone();
  await login(m2.page, 'medic2@test');
  await enter(m2.page);
  await addPatient(m2.page, P1, 'P001-T', 'yellow');
  await m2.page.evaluate((id) => requestPcReview(id, 'manual'), P1);
  await syncAll(m2.page);
  assert(rows(P1).length === 2, `${rel}: the second medic's request is its own row`);

  // 6. PC on another phone: one line per casualty, with "סקירה" and "אחר כך".
  const pc = await phone();
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  for (const [id, vis, t] of [[P1, 'P001-T', 'yellow'], [P3, 'P003-T', 'red']]) await addPatient(pc.page, id, vis, t);
  await pullReviews(pc.page);
  let html = await strip(pc.page, 'pc');
  assert((html.match(/data-pc-review="55555555-5555-4555-8555-000000000001"/g) || []).length === 1 && html.includes('חובש ראשון') && html.includes('חובש שני'),
    `${rel}: one strip line for P1 naming both medics (got ${html})`);
  assert(html.includes('data-pc-review="55555555-5555-4555-8555-000000000003"') && html.includes('אחר כך 3 דק׳') && html.includes('אחר כך 5 דק׳'), `${rel}: P3 (red) offers a 3-minute delay, P1 a 5-minute one`);
  await pc.page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullMedicalResourceRequests(id))));
  await pc.page.waitForTimeout(200);
  assert((await pc.page.evaluate(() => reinforcementRequests.length)) === 0, `${rel}: the reinforcement pull must skip pc_review rows`);

  // 7. PC puts P1 off: both rows wait on the server, the line becomes a chip; the CC sees who and until when.
  await pc.page.evaluate((id) => snoozePcReview(id), P1);
  await syncAll(pc.page);
  assert(rows(P1).every((r) => r.status === 'acknowledged' && r.snoozed_until && r.snooze_count === 1), `${rel}: the delay applies to both reviews of P1 (got ${JSON.stringify(rows(P1))})`);
  html = await strip(pc.page, 'pc');
  assert(!html.includes('data-pc-review="55555555-5555-4555-8555-000000000001"') && html.includes('data-pc-review-chip="55555555-5555-4555-8555-000000000001"'), `${rel}: a put-off review is a chip on the PC's strip`);
  const cc = await phone();
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  for (const [id, vis, t] of [[P1, 'P001-T', 'yellow'], [P3, 'P003-T', 'red']]) await addPatient(cc.page, id, vis, t);
  await pullReviews(cc.page);
  html = await strip(cc.page, 'cc');
  assert(html.includes('data-pc-review="55555555-5555-4555-8555-000000000001"') && html.includes('נדחה ע״י') && !html.includes('אחר כך'), `${rel}: the CC sees the delay, and cannot put it off (got ${html})`);

  // 8. Nobody answered P3 for 5 minutes: red on the PC, "לא נענה" on the CC. A delay that ran out comes back.
  for (const page of [pc.page, cc.page]) await page.evaluate((id) => { pcReviews.filter((r) => r.linkedPatientIds.includes(id)).forEach((r) => { r.createdAt = new Date(Date.now() - 6 * 60000).toISOString(); }); }, P3);
  html = await strip(pc.page, 'pc');
  assert(/cmd-strip-alert crit" data-pc-review="55555555-5555-4555-8555-000000000003" data-pc-review-state="unanswered"/.test(html) && html.includes('לא נענה 6 דק׳'), `${rel}: an unanswered review turns red on the PC (got ${html})`);
  html = await strip(cc.page, 'cc');
  assert(html.includes('לא נענה'), `${rel}: the CC sees "לא נענה"`);
  await pc.page.evaluate((id) => { pcReviews.filter((r) => r.linkedPatientIds.includes(id)).forEach((r) => { r.snoozedUntil = new Date(Date.now() - 1000).toISOString(); }); }, P1);
  html = await strip(pc.page, 'pc');
  assert(/data-pc-review="55555555-5555-4555-8555-000000000001" data-pc-review-state="unanswered"/.test(html) && html.includes('אחר כך 5 דק׳'), `${rel}: a delay that ran out brings the line back, with the second delay`);

  // 9. A red casualty's one delay used: no more "אחר כך" for the PC, and the CC is told.
  await pc.page.evaluate((id) => snoozePcReview(id), P3);
  await syncAll(pc.page);
  await pc.page.evaluate((id) => { pcReviews.filter((r) => r.linkedPatientIds.includes(id)).forEach((r) => { r.snoozedUntil = new Date(Date.now() - 1000).toISOString(); }); }, P3);
  html = await strip(pc.page, 'pc');
  assert(lineFor(html, P3) && !lineFor(html, P3).includes('אחר כך'), `${rel}: no second delay for a red casualty (got ${lineFor(html, P3)})`);
  await pullReviews(cc.page);
  await cc.page.evaluate((id) => { pcReviews.filter((r) => r.linkedPatientIds.includes(id)).forEach((r) => { r.snoozedUntil = new Date(Date.now() + 60000).toISOString(); }); }, P3);
  html = await strip(cc.page, 'cc');
  assert(html.includes('נוצלו הדחיות'), `${rel}: the CC sees that the delays are used up (got ${html})`);

  // 10. The medic may not close a review.
  await m1.page.evaluate((id) => { const r = pcReviews.find((x) => x.linkedPatientIds.includes(id)); queuePcReviewStatus(r, { status: 'resolved', outcome: 'priority_kept' }); }, P3);
  await syncAll(m1.page);
  assert(rows(P3)[0].status === 'acknowledged' && !rows(P3)[0].review_outcome, `${rel}: a medic must not close a review (got ${JSON.stringify(rows(P3))})`);

  // 11. PC closes P1 with an outcome: both rows close; the medic's phone says what the PC decided.
  await pc.page.evaluate((id) => openPcReviewSheet(id), P1);
  assert(await pc.page.locator('#pc-review-sheet [data-pc-review-outcome]').count() === 4, `${rel}: the review sheet offers the four outcomes`);
  await pc.page.click('#pc-review-sheet [data-pc-review-outcome="priority_kept"]');
  await syncAll(pc.page);
  assert(rows(P1).every((r) => r.status === 'resolved' && r.review_outcome === 'priority_kept'), `${rel}: one decision closes both reviews of P1 (got ${JSON.stringify(rows(P1))})`);
  await pullReviews(m1.page);
  const seen = await m1.page.evaluate((id) => { openPatient(id); const el = document.querySelector('[data-pc-review-status]'); return { state: el?.dataset.pcReviewStatus, text: el?.innerText || '', timeline: patients.find((p) => p.id === id).events.some((e) => e.type === 'PC_REVIEW_CLOSED') }; }, P1);
  assert(seen.state === 'closed' && seen.text.includes('חוג"ד סקר: נשארה קדימות') && seen.text.includes('חוג״ד בדיקה') && seen.timeline, `${rel}: the medic sees the PC's decision (got ${JSON.stringify(seen)})`);
  html = await strip(pc.page, 'pc');
  assert(!html.includes('data-pc-review="55555555-5555-4555-8555-000000000001"'), `${rel}: a closed review leaves the strip`);

  // 12. "עודכנה קדימות" opens the casualty's priority buttons on the PC's phone.
  await pc.page.evaluate((id) => closePcReview(id, 'priority_updated'), P3);
  await pc.page.waitForTimeout(150);
  const opened = await pc.page.evaluate(() => ({ screen: activeScreenId(), card: !!document.getElementById('triage-override-card') }));
  assert(opened.card && opened.screen === 'patient', `${rel}: "עודכנה קדימות" must open the priority buttons (got ${JSON.stringify(opened)})`);
  await syncAll(pc.page);
  assert(rows(P3)[0].status === 'resolved' && rows(P3)[0].review_outcome === 'priority_updated', `${rel}: P3 closed with its outcome`);

  // 13. Every medic of the incident sees the PC's decision, also on a casualty they did not ask about.
  await pullReviews(m2.page);
  const all = await reviews(m2.page);
  assert(all.length === rows().length && all.some((r) => r.by === 'חובש ראשון'), `${rel}: a medic receives every review of the incident (got ${JSON.stringify(all)})`);
  await addPatient(m2.page, P3, 'P003-T', 'red');
  const other = await m2.page.evaluate((id) => { openPatient(id); const el = document.querySelector('[data-pc-review-status]'); return { state: el?.dataset.pcReviewStatus, text: el?.innerText || '' }; }, P3);
  assert(other.state === 'closed' && other.text.includes('עודכנה קדימות'), `${rel}: the second medic sees the PC's decision on the first medic's casualty (got ${JSON.stringify(other)})`);

  // 14. The casualty leaves the scene: the server closes the open review (093); no line, the medic sees why.
  await pullReviews(pc.page);
  assert((await strip(pc.page, 'pc')).includes(`data-pc-review="${P4}"`), `${rel}: P4's review is on the PC's strip before the casualty leaves`);
  // Before the server's close arrives the line already goes (the phone knows the casualty left) ...
  await pc.page.evaluate((id) => { const p = patients.find((x) => x.id === id); if (p) p.patientStatus = 'handed_over'; }, P4);
  assert(!(await strip(pc.page, 'pc')).includes(`data-pc-review="${P4}"`), `${rel}: a casualty who left the scene has no review line`);
  // ... and the server closes the row.
  const r4 = rows(P4)[0];
  Object.assign(r4, { status: 'closed', snoozed_until: null, status_updated_at: new Date().toISOString() });
  r4.status_history.push({ status: 'closed', at: new Date().toISOString(), by_name: 'מערכת', by_role: 'system', reason: 'patient_left_scene' });
  await pullReviews(pc.page);
  assert((await reviews(pc.page)).find((r) => r.serverId === r4.id)?.status === 'closed', `${rel}: the closed row reaches the PC`);
  await pullReviews(m1.page);
  const exit = await m1.page.evaluate((id) => { openPatient(id); const el = document.querySelector('[data-pc-review-status]'); return { state: el?.dataset.pcReviewStatus, text: el?.innerText || '' }; }, P4);
  assert(exit.state === 'closed-exit' && exit.text.includes('הפצוע יצא מהזירה'), `${rel}: the medic sees the review closed because the casualty left (got ${JSON.stringify(exit)})`);

  // 15. After-action figures on the PC's phone: "עודכנה קדימות" with no priority change is flagged,
  // and stops being flagged once the priority really changes.
  const aar = async () => pc.page.evaluate(() => { renderAar(); const v = (k) => document.querySelector(`[data-aar="${k}"] .aar-num`)?.textContent; return { total: v('pc-review-total'), median: v('pc-review-median'), unanswered: v('pc-review-unanswered'), unconfirmed: v('pc-review-unconfirmed'), insight: document.getElementById('aar-insights').innerText }; });
  let a = await aar();
  assert(a.unconfirmed === '1' && a.insight.includes('P003-T') && Number(a.total) >= 4 && a.median !== '—', `${rel}: the AAR flags the priority update that did not happen (got ${JSON.stringify(a)})`);
  await pc.page.evaluate((id) => manualTriageOverride(id, 'black'), P3);
  a = await aar();
  assert(a.unconfirmed === '0', `${rel}: a real priority change clears the flag (got ${JSON.stringify(a)})`);

  // 16. Text another user typed reaches this phone stripped of markup characters.
  SERVER.medical_resource_requests.push({ ...JSON.parse(JSON.stringify(rows(P3)[0])), id: 'bbbbbbbb-0000-4000-8000-000000000001', origin_client_request_id: 'REQ-EVIL', status: 'pending',
    review_outcome: '<b>', free_text: '<img src=x onerror=window.__xss=1>SpO₂', requested_by_name: '<script>window.__xss=1</script>', requested_at: new Date().toISOString() });
  await pullReviews(pc.page);
  html = await strip(pc.page, 'pc');
  await pc.page.evaluate((h) => { const d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d); }, html);
  await pc.page.waitForTimeout(100);
  assert(!(await pc.page.evaluate(() => window.__xss)), `${rel}: remote text must not run`);
  const evil = (await reviews(pc.page)).find((r) => r.serverId === 'bbbbbbbb-0000-4000-8000-000000000001');
  assert(evil && !/[<>]/.test(evil.by) && evil.outcome === null, `${rel}: remote names arrive without markup, an unknown outcome is dropped (got ${JSON.stringify(evil)})`);

  assert(!SERVER.rejected.length, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...m1.errors, ...m2.errors, ...pc.errors, ...cc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: PC review of a deteriorating casualty cross-device browser test passed`);
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
