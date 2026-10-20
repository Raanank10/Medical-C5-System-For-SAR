// Real-browser test of treatments shown on other devices (V2.99.41, docs/GAP_CLOSURE_PLAN.md WP-3
// step 6, database/055). A medic and a CC (two browser contexts, so two separate devices) share
// one fake backend in this Node process, the same harness as scripts/browser_alert_ack_sync_test.js.
// The fake answers vw_patient_treatment_history from the pushed events, with device_id, as 055 does.
// It proves client behavior only; database/055 itself must be exercised against real Postgres.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_remote_treatments_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html'), path.join(root, 'demo', 'rescue-app.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const CC = '33333333-3333-4333-8333-333333333333';
const MEDIC = '11111111-1111-4111-8111-111111111111';
const PATIENT = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש ראשון' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const TX = ['INTERVENTION_RECORDED', 'MEDICATION_ADMINISTERED', 'AIRWAY_MANAGED', 'TOURNIQUET_APPLIED'];
const ALLOWED = { medic: TX, cc: [] };

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [MEDIC].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    events: [],
    rejected: [],
  };
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    server.events.push({ ...e, id: `ev-${server.events.length + 1}`, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId });
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
  if (req.table === 'vw_patient_treatment_history') {
    // database/055: events of the treatment types, with device_id; security_invoker (events RLS).
    const rows = server.events.filter((e) => TX.includes(e.type) && server.incidents.some((i) => i.id === e.incident_id && canSee(i)))
      .map((e) => ({ event_id: e.id, incident_id: e.incident_id, patient_id: e.patient_id, type: e.type, local_timestamp: e.local_timestamp,
        treatment_type: e.payload_json?.treatment_type ?? null, medication: e.payload_json?.medication ?? null, payload_json: e.payload_json, device_id: e.device_id }))
      .filter(match).sort((a, b) => Date.parse(b.local_timestamp) - Date.parse(a.local_timestamp));
    return { data: clone(rows), error: null };
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

async function pullTx(page) {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullRemoteTreatments(id))));
  await page.waitForTimeout(200);
}
const addPatients = (page) => page.evaluate(([a, b]) => {
  for (const id of [a, b]) patients.push({ id, visualId: id === a ? 'P-TX' : 'P-OTHER', triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], txHistory: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], time: '10:00' });
}, [PATIENT, OTHER]);
const remote = (page, pid) => page.evaluate((id) => (patients.find((x) => x.id === id).remoteTreatments || []).map((t) => t.text), pid);

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
  await addPatients(m.page);
  const cc = await phone();
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await addPatients(cc.page);

  // 1. The medic records a bandage, an opened airway and morphine for one patient, plus a tourniquet.
  await m.page.evaluate((pid) => {
    queueTreatmentEvent(pid, 'bandage', 'חבישה');
    queueTreatmentEvent(pid, 'airway', 'פתיחת נתיב אוויר');
    saveLocalEvent({ type: 'MEDICATION_ADMINISTERED', patient_id: pid, detail: 'Morphine', payload_json: { medication: 'Morphine', dosage: '5mg', route: 'IV' } });
    saveLocalEvent({ type: 'MEDICATION_ADMINISTERED', patient_id: pid, detail: 'ATQ', payload_json: { medication: 'ATQ', dosage: null, source: 'vitals_modal' } });
    saveLocalEvent({ type: 'TOURNIQUET_APPLIED', patient_id: pid, detail: 'TQ', payload_json: { tourniquet_id: 'TQ-1', limb: 'left_leg' } });
  }, PATIENT);
  await syncAll(m.page);
  assert(SERVER.events.length === 5, `${rel}: five treatment events must reach the server (got ${SERVER.events.length})`);

  // 2. The CC's device shows them on the patient card, in their own section; not the tourniquet.
  await pullTx(cc.page);
  const tx = await remote(cc.page, PATIENT);
  assert(tx.length === 4, `${rel}: CC must see four remote treatments (got ${JSON.stringify(tx)})`);
  assert(tx.some((t) => t === 'חבישה') && tx.some((t) => t === 'פתיחת נתיב אוויר') && tx.some((t) => t.startsWith('Morphine 5mg IV')) && tx.some((t) => t.includes('ATQ') && t.includes('ללא מינון')), `${rel}: labels, dose and missing dose must be shown (got ${JSON.stringify(tx)})`);
  assert((await remote(cc.page, OTHER)).length === 0, `${rel}: another patient must not get them`);
  await cc.page.evaluate((pid) => openPatient(pid), PATIENT);
  const card = (await cc.page.textContent('#detail-body')).replace(/\s+/g, ' ');
  assert(card.includes('טיפולים ממכשירים אחרים (4)') && card.includes('נרשם במכשיר אחר'), `${rel}: the CC's patient card must list them (got ${card.slice(0, 300)})`);
  const local = await cc.page.evaluate((pid) => (patients.find((x) => x.id === pid).txHistory || []).length, PATIENT);
  assert(local === 0, `${rel}: remote treatments must not be mixed into the device's own txHistory`);

  // 3. The medic's own device does not list its own treatments a second time.
  await pullTx(m.page);
  assert((await remote(m.page, PATIENT)).length === 0, `${rel}: a device must not show its own treatments as remote`);

  // 4. Text another user typed reaches this phone stripped of markup characters.
  SERVER.events.push({ id: 'ev-evil', type: 'INTERVENTION_RECORDED', patient_id: PATIENT, incident_id: SERVER.events[0].incident_id, device_id: 'other-device', local_timestamp: new Date().toISOString(),
    payload_json: { treatment_type: 'other_tx', treatment_label: '<img src=x onerror=window.__xss=1>קיבוע' } });
  await pullTx(cc.page);
  await cc.page.evaluate((pid) => openPatient(pid), PATIENT);
  const evil = (await remote(cc.page, PATIENT)).find((t) => t.includes('קיבוע'));
  assert(evil && !/[<>]/.test(evil) && !(await cc.page.evaluate(() => window.__xss)), `${rel}: remote treatment text must arrive without markup (got ${evil})`);

  assert(!SERVER.rejected.length, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...m.errors, ...cc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: remote treatments browser test passed`);
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
