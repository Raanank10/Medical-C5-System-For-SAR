// Real-browser test of shared alert acknowledgment (V2.99.40, docs/GAP_CLOSURE_PLAN.md WP-4,
// database/054). A medic and a PC (two browser contexts, so two separate devices) share one fake
// backend in this Node process, the same harness as scripts/browser_reinforcement_sync_test.js. The
// fake mirrors project_alert_acknowledgment(): WATCHDOG_ACKNOWLEDGED sets
// patients.alert_acknowledged_* (newest wins); WATCHDOG_ALERT with reason 'reescalated' clears it
// when the acknowledgment is not newer.
// It proves client behavior only; database/054 itself must be exercised against real Postgres.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_alert_ack_sync_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const PC = '22222222-2222-4222-8222-222222222222';
const MEDIC = '11111111-1111-4111-8111-111111111111';
const PATIENT = '55555555-5555-4555-8555-555555555555';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש ראשון' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const ACK = 'WATCHDOG_ACKNOWLEDGED';
const ALERT = 'WATCHDOG_ALERT';
// sync-log SYSTEM_EVENTS: every role. The medic's re-escalation also sends a triage update.
const ALLOWED = { pc: [ACK, ALERT, 'PATIENT_TRIAGE_UPDATED'], medic: [ACK, ALERT, 'PATIENT_TRIAGE_UPDATED', 'PATIENT_STATUS_UPDATED'] };

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [PC, MEDIC].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    patients: [{ id: PATIENT, incident_id: INC1, visual_id: 'P-ACK', alert_acknowledged_at: null, alert_acknowledged_by: null, alert_acknowledged_by_name: null, alert_acknowledged_by_role: null }],
    events: [],
    rejected: [],
  };
}

// Port of project_alert_acknowledgment() (database/054).
function project(server, evt, actorId) {
  if (!evt.patient_id) return;
  const u = userById(actorId);
  const p = server.patients.find((x) => x.id === evt.patient_id);
  if (!p) return;
  const t = Date.parse(evt.local_timestamp);
  if (evt.type === ACK) {
    if (!p.alert_acknowledged_at || Date.parse(p.alert_acknowledged_at) <= t) {
      Object.assign(p, { alert_acknowledged_at: evt.local_timestamp, alert_acknowledged_by: actorId, alert_acknowledged_by_name: u.display_name, alert_acknowledged_by_role: u.role });
    }
  } else if (evt.type === ALERT && evt.payload_json?.reason === 'reescalated') {
    if (p.alert_acknowledged_at && Date.parse(p.alert_acknowledged_at) <= t) {
      Object.assign(p, { alert_acknowledged_at: null, alert_acknowledged_by: null, alert_acknowledged_by_name: null, alert_acknowledged_by_role: null });
    }
  }
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    const evt = { ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId };
    server.events.push(evt);
    project(server, evt, userId);
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
  if (req.table === 'patients') {
    // Only the acknowledgment query is answered with rows; the other patient pulls get nothing,
    // so the test controls exactly which patients exist on each device.
    if (!(req.select || '').includes('alert_acknowledged_at')) return { data: req.single ? null : [], error: null };
    return { data: clone(visible(server.patients)), error: null };
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
    b.select=(c)=>{ q.select=c; return b; }; b.eq=(c,v)=>{ q.eq[c]=v; return b; }; b.in=(c,v)=>{ q.in[c]=v; return b; };
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

async function pullAck(page) {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullAlertAcknowledgments(id))));
  await page.waitForTimeout(200);
}
const addPatient = (page) => page.evaluate((pid) => {
  patients.push({ id: pid, visualId: 'P-ACK', triage: 'yellow', patientStatus: 'observing', siteId: 'SITE_A', alert: true, deterioration: ['דופק גבוה'], events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], time: '10:00' });
}, PATIENT);
const ackState = (page) => page.evaluate((pid) => { const p = patients.find((x) => x.id === pid); return { at: p.alertAcknowledgedAt || null, name: p.alertAcknowledgedByName || null, remote: !!p.alertAckFromServer }; }, PATIENT);

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

  const m = await phone();
  await login(m.page, 'medic@test');
  await enter(m.page);
  await addPatient(m.page);
  const pc = await phone();
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  await addPatient(pc.page);

  // 1. The medic presses "בטיפול": the acknowledgment reaches the server, patient-scoped.
  await m.page.evaluate((pid) => acknowledgeAlert(pid), PATIENT);
  assert((await m.page.evaluate((pid) => patients.find((x) => x.id === pid).unsyncedEvents || 0, PATIENT)) === 0, `${rel}: the old never-clearing counter must not be bumped`);
  await syncAll(m.page);
  // V2.99.61: the sync pills and the command strip show the last real answer from the sync
  // function, not this phone's own saves; with the sync function unreachable, contact goes stale.
  const contact = await m.page.evaluate(async () => {
    lastServerContactAt = null;
    await syncPull(SITE_TO_INCIDENT_ID.SITE_A);
    const afterPull = { at: lastServerContactAt, label: serverContactLabel() };
    lastServerContactAt = null;
    const realFetch = window.fetch;
    window.fetch = (url, opts) => (String(url).includes('/functions/v1/sync-log') ? Promise.reject(new TypeError('Failed to fetch')) : realFetch(url, opts));
    await syncPull(SITE_TO_INCIDENT_ID.SITE_A);
    window.fetch = realFetch;
    const offline = { at: lastServerContactAt, label: serverContactLabel() };
    await syncPull(SITE_TO_INCIDENT_ID.SITE_A);
    return { afterPull, offline };
  });
  assert(contact.afterPull.at && contact.afterPull.label.startsWith('מחובר לשרת'), `${rel}: a successful sync pull must record server contact (got ${JSON.stringify(contact.afterPull)})`);
  assert(!contact.offline.at && contact.offline.label.startsWith('אין קשר לשרת'), `${rel}: a failed sync pull must not count as server contact (got ${JSON.stringify(contact.offline)})`);
  const row = SERVER.patients[0];
  assert(row.alert_acknowledged_by === MEDIC && row.alert_acknowledged_at, `${rel}: the acknowledgment must reach the server (got ${JSON.stringify(row)})`);
  assert(SERVER.events.filter((e) => e.type === 'WATCHDOG_ACKNOWLEDGED' && e.patient_id === PATIENT).length === 1, `${rel}: exactly one patient-scoped WATCHDOG_ACKNOWLEDGED`);

  // 2. The PC's device shows the alert as handled, with who and when.
  let pcAck = await ackState(pc.page);
  assert(!pcAck.at, `${rel}: before the pull the PC has no acknowledgment`);
  await pullAck(pc.page);
  pcAck = await ackState(pc.page);
  assert(pcAck.at && pcAck.remote && pcAck.name === 'חובש ראשון', `${rel}: the PC must see the medic's acknowledgment (got ${JSON.stringify(pcAck)})`);
  await pc.page.evaluate((pid) => openPatient(pid), PATIENT);
  const card = (await pc.page.textContent('#detail-body')).replace(/\s+/g, ' ');
  assert(card.includes('התראה בטיפול') && card.includes('חובש ראשון'), `${rel}: the PC's patient card must say who is handling it (got ${card.slice(0, 300)})`);
  const pcActive = await pc.page.evaluate((pid) => { const p = patients.find((x) => x.id === pid); return p.alert === true && !p.alertAcknowledgedAt; }, PATIENT);
  assert(!pcActive, `${rel}: the alert must no longer be active on the PC's device`);

  // 3. The medic's own device keeps its acknowledgment after the pull, shown as "את/ה".
  await pullAck(m.page);
  const mAck = await ackState(m.page);
  assert(mAck.at && !mAck.remote, `${rel}: the medic's own acknowledgment stays local-owned (got ${JSON.stringify(mAck)})`);

  // 4. The patient gets worse on the medic's device (red triage): the acknowledgment is cleared
  //    everywhere, not only on the medic's phone.
  await m.page.evaluate((pid) => manualTriageOverride(pid, 'red'), PATIENT);
  assert(!(await ackState(m.page)).at, `${rel}: re-escalation clears the local acknowledgment`);
  // Not pushed yet: the PC still shows it handled, and the medic's unsent re-escalation is not undone by a pull.
  await pullAck(m.page);
  assert(!(await ackState(m.page)).at, `${rel}: an unsent re-escalation must not be undone by a pull`);
  await syncAll(m.page);
  assert(SERVER.patients[0].alert_acknowledged_at === null, `${rel}: the re-escalation must clear the server acknowledgment`);
  const reesc = SERVER.events.find((e) => e.type === 'WATCHDOG_ALERT' && e.patient_id === PATIENT);
  assert(reesc && reesc.payload_json.reason === 'reescalated', `${rel}: the re-escalation must be sent as WATCHDOG_ALERT reason=reescalated`);
  await pullAck(pc.page);
  assert(!(await ackState(pc.page)).at, `${rel}: the PC must see the alert active again`);

  // 5. A re-escalation without an earlier acknowledgment sends nothing extra.
  const before = SERVER.events.filter((e) => e.type === 'WATCHDOG_ALERT').length;
  await m.page.evaluate((pid) => manualTriageOverride(pid, 'red'), PATIENT);
  await syncAll(m.page);
  assert(SERVER.events.filter((e) => e.type === 'WATCHDOG_ALERT').length === before, `${rel}: no re-escalation event when nothing was acknowledged`);

  // 6. Text another user typed reaches this phone stripped of markup characters.
  Object.assign(SERVER.patients[0], { alert_acknowledged_at: new Date(Date.now() + 1000).toISOString(), alert_acknowledged_by: MEDIC, alert_acknowledged_by_name: '<img src=x onerror=window.__xss=1>חובש', alert_acknowledged_by_role: 'medic' });
  await pullAck(pc.page);
  await pc.page.evaluate((pid) => openPatient(pid), PATIENT);
  assert(!(await pc.page.evaluate(() => window.__xss)) && !/[<>]/.test((await ackState(pc.page)).name || ''), `${rel}: a remote name must arrive without markup`);

  assert(!SERVER.rejected.length, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...m.errors, ...pc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: shared alert acknowledgment cross-device browser test passed`);
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
