// Real-browser test of patient numbers (visual_id) across phones (V2.99.51). On 2026-10-20 a live
// MSTART sweep of 10 casualties stored 1 patient: every marker was named TMP-001 (the counter
// looked at p.id, a UUID since the server sync), the server keeps one patient per
// incident + visual_id, and sync-log took the clash for a retried push, so the other 9 creates
// were skipped and their events failed the patient FK.
// Two medics whose names give the same initials (two browser contexts, so two devices) share one
// fake backend that copies sync-log's patient-create rule and the real UNIQUE (incident_id, visual_id):
// - sweep markers count up and carry the registrant's initials (TMP-001-DK, TMP-002-DK, ...);
// - a full/quick patient gets P00n-<initials>;
// - when the second medic, offline, makes the same TMP-001-DK, the server creates that patient under
//   a renamed id, every event of both medics is accepted, and the second phone shows the new id;
// - a later server rename (merge_incident, database/067) reaches the phone on the next pull;
// - local demo (signed out) keeps plain ids and still counts up.
// It proves client behavior and the rule the fake server copies; sync-log itself runs on Deno.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_patient_number_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const MEDIC_A = '44444444-4444-4444-8444-444444444444';
const MEDIC_B = '55555555-5555-4555-8555-555555555555';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Synthetic Hebrew names; both transliterate to the initials DK.
const USERS = {
  'medic-a@test': { id: MEDIC_A, role: 'medic', display_name: 'דני כהן' },
  'medic-b@test': { id: MEDIC_B, role: 'medic', display_name: 'דנה כץ' },
};
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const CREATE = ['PATIENT_CREATED', 'QUICK_PATIENT_CREATED', 'FIRST_RESPONDER_REPORT'];

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [MEDIC_A, MEDIC_B].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: 'medic', assigned_by: null, created_at: now })),
    patients: [],
    events: [],
    rejected: [],
  };
}

// Copy of sync-log's patient-create step (supabase/functions/sync-log/index.ts).
function createPatient(server, body, e) {
  const visualId = e.payload_json?.visual_id ?? e.local_event_id;
  const clash = (v) => server.patients.some((p) => p.incident_id === body.incident_id && p.visual_id === v);
  if (server.patients.some((p) => p.id === e.patient_id)) return { ok: true };
  let chosen = visualId;
  let renamed = null;
  if (clash(visualId)) {
    const suffix = String(body.device_id).replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase() || 'DUP';
    chosen = null;
    for (let n = 1; n <= 5 && !chosen; n++) {
      const v = n === 1 ? `${visualId}-${suffix}` : `${visualId}-${suffix}-${n}`;
      if (!clash(v)) { chosen = v; renamed = v; }
    }
    if (!chosen) return { ok: false };
  }
  server.patients.push({ id: e.patient_id, incident_id: body.incident_id, visual_id: chosen, current_triage: 'pending', current_status: 'identified', access_status: null, needs_full_assessment: true, version: 1 });
  return { ok: true, renamed };
}

function push(server, userId, body) {
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    let renamed = null;
    if (CREATE.includes(e.type) && e.patient_id) {
      const r = createPatient(server, body, e);
      if (!r.ok) { rejected.push({ local_event_id: e.local_event_id, terminal: false, error_code: 'PATIENT_CREATE_FAILED' }); server.rejected.push(e.type); continue; }
      renamed = r.renamed;
    }
    if (e.patient_id && !server.patients.some((p) => p.id === e.patient_id)) {
      rejected.push({ local_event_id: e.local_event_id, terminal: false, error_code: 'MALFORMED_EVENT_ENVELOPE', message: 'events_patient_id_fkey' });
      server.rejected.push(e.type);
      continue;
    }
    server.events.push({ ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId });
    accepted.push({ local_event_id: e.local_event_id, ...(renamed ? { patient_visual_id: renamed } : {}) });
  }
  return { accepted, duplicates: [], rejected, blocked_dependency: [], high_risk_flags: [], field_conflicts: [] };
}

function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const match = (row) => Object.entries(req.eq || {}).every(([c, v]) => row[c] === v)
    && Object.entries(req.in || {}).every(([c, v]) => v.includes(row[c]));
  const member = (incId) => server.members.some((m) => m.incident_id === incId && m.profile_id === u.id);
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') return { data: clone(server.incidents.map((i) => ({ ...i, patient_count: 0, is_member: member(i.id) }))), error: null };
    if (req.name === 'join_incident') return { data: { id: p.p_incident_id }, error: null };
    if (req.name === 'get_incident_command_state') return { data: { incident_id: p.p_incident_id, status: 'active', state_json: {} }, error: null };
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true })).filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const vis = server.incidents.filter((i) => member(i.id) && match(i));
    if (req.op === 'update') return { data: [], error: null };
    const data = req.single ? (vis[0] || null) : vis;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'patients') {
    if (req.op !== 'select') return { data: null, error: null };
    const rows = server.patients.filter((p) => member(p.incident_id)).filter(match);
    return { data: clone(rows), error: null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') return { data: null, error: null };
    let vis = server.members.filter((r) => r.profile_id === u.id).filter(match);
    if (req.limit) vis = vis.slice(0, req.limit);
    return { data: clone(req.single ? (vis[0] || null) : vis), error: null };
  }
  return { data: req.single ? null : [], error: null };
}

const FAKE_SUPABASE = `
(function(){
  const USERS=${JSON.stringify(USERS)};
  const session=()=>{ try{ return JSON.parse(sessionStorage.getItem('__fake_session')); }catch(e){ return null; } };
  const userId=()=>session()?.user?.id||null;
  function builder(table){
    const q={kind:'from',table,op:'select',eq:{},in:{},single:false,limit:null,payload:null};
    const b={};
    b.select=()=>b; b.eq=(c,v)=>{ q.eq[c]=v; return b; }; b.in=(c,v)=>{ q.in[c]=v; return b; };
    b.limit=n=>{ q.limit=n; return b; }; b.single=()=>{ q.single=true; return b; }; b.maybeSingle=b.single;
    b.update=p=>{ q.op='update'; q.payload=p; return b; };
    b.upsert=p=>{ q.op='upsert'; q.payload=p; return b; };
    ['not','order','gte','gt','lt','lte','neq','is','range','insert','delete'].forEach(m=>{ b[m]=b[m]||(()=>b); });
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

let SERVER = null;

async function openPhone(context, file) {
  const page = await context.newPage();
  const errors = [];
  const toasts = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.exposeFunction('__toastSeen', (t) => toasts.push(t));
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/functions/v1/sync-log**', (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) });
    const userId = (r.request().headers().authorization || '').replace('Bearer tok-', '');
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(push(SERVER, userId, r.request().postDataJSON())) });
  });
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { const t = window.toast; window.toast = (m, ...rest) => { window.__toastSeen(String(m)); return t(m, ...rest); }; });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  return { page, errors, toasts };
}
async function login(page, email) {
  await page.waitForSelector('#screen-login.active', { timeout: 5000 });
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'synthetic');
  await page.click('#login-submit-btn');
  await page.waitForFunction(() => !!currentUser, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await page.waitForTimeout(300);
}
const sweep = (page, count) => page.evaluate((count) => {
  goTo('sweep');
  const ids = [];
  for (let i = 0; i < count; i++) { startSweepCasualtyMarker(); ids.push({ id: activeSweepPatient().id, visualId: activeSweepPatient().visualId }); }
  return ids;
}, count);
const pushAll = async (page) => { await page.evaluate(async () => { await syncPush(); await syncPush(); }); await page.waitForTimeout(300); };

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

  // 1. Medic A sweeps three casualties: each gets its own number, with A's initials.
  const a = await phone();
  await login(a.page, 'medic-a@test');
  const aSweep = await sweep(a.page, 3);
  assert(JSON.stringify(aSweep.map((x) => x.visualId)) === JSON.stringify(['TMP-001-DK', 'TMP-002-DK', 'TMP-003-DK']),
    `${rel}: sweep markers must count up with the registrant's initials (got ${aSweep.map((x) => x.visualId)})`);
  const ini = await a.page.evaluate(() => [latinInitials('דני כהן'), latinInitials('Dan Cohen'), latinInitials('שָׁרָה'), latinInitials('ד"ר צבי'), latinInitials('123'), latinInitials('')]);
  assert(JSON.stringify(ini) === JSON.stringify(['DK', 'DC', 'SR', 'DZ', '', '']), `${rel}: initials must be Latin letters only (got ${ini})`);
  const nextP = await a.page.evaluate(() => nextVisualId());
  assert(/^P\d{3}-DK$/.test(nextP), `${rel}: a new patient must be P00n-<initials> (got ${nextP})`);
  await pushAll(a.page);
  assert(SERVER.patients.length === 3 && SERVER.rejected.length === 0, `${rel}: all three sweep patients must reach the server (patients ${SERVER.patients.length}, rejected ${SERVER.rejected})`);

  // 2. Medic B, same initials, has not pulled yet (offline) and makes TMP-001-DK too.
  const b = await phone();
  await login(b.page, 'medic-b@test');
  await b.page.evaluate(() => { patients.splice(0, patients.length, ...patients.filter((p) => !p.sourcedFromRemote)); });
  const bSweep = await sweep(b.page, 1);
  assert(bSweep[0].visualId === 'TMP-001-DK', `${rel}: the test needs a real clash (got ${bSweep[0].visualId})`);
  await pushAll(b.page);
  assert(SERVER.rejected.length === 0, `${rel}: a clashing number must not lose the patient or its events (rejected ${SERVER.rejected})`);
  const bRow = SERVER.patients.find((p) => p.id === bSweep[0].id);
  assert(bRow && /^TMP-001-DK-[A-Z0-9]{4}$/.test(bRow.visual_id), `${rel}: the server must create B's patient under a renamed id (got ${bRow && bRow.visual_id})`);
  const bLocal = await b.page.evaluate((id) => patients.find((p) => p.id === id).visualId, bSweep[0].id);
  assert(SERVER.patients.every((p) => /^[A-Z0-9-]+$/.test(p.visual_id)), `${rel}: patient ids must be Latin letters, digits and '-' only (got ${SERVER.patients.map((p) => p.visual_id)})`);
  assert(bLocal === bRow.visual_id, `${rel}: B's phone must show the server's id right after the push (got ${bLocal})`);
  assert(b.toasts.some((t) => t.includes(bRow.visual_id)), `${rel}: B must be told the patient got a new number`);

  // 3. A later rename on the server (as merge_incident does) reaches A's phone on the next pull.
  const aRow = SERVER.patients.find((p) => p.id === aSweep[1].id);
  aRow.visual_id = 'TMP-002-DK-MRG1'; aRow.version = 2;
  await a.page.evaluate(async () => { await pullProjectedPatientStateAll(); });
  await a.page.waitForTimeout(300);
  const aLocal = await a.page.evaluate((id) => { const p = patients.find((q) => q.id === id); return { v: p.visualId, note: (p.events || [])[0]?.detail || '' }; }, aSweep[1].id);
  assert(aLocal.v === 'TMP-002-DK-MRG1' && aLocal.note.includes('TMP-002-DK-MRG1'), `${rel}: a server rename must reach the phone with a timeline note (got ${JSON.stringify(aLocal)})`);

  // 4. Local demo (signed out): plain ids, still counting up from visualId.
  const demo = await a.page.evaluate(() => {
    const u = currentUser; const saved = patients.slice();
    currentUser = null;
    patients.splice(0, patients.length, { id: newUuid(), visualId: 'TMP-001' }, { id: newUuid(), visualId: 'TMP-002' });
    const out = { tmp: createTmpCasualtyId(), p: nextVisualId() };
    patients.splice(0, patients.length, ...saved); currentUser = u;
    return out;
  });
  assert(demo.tmp === 'TMP-003' && demo.p === 'P003', `${rel}: local demo must keep plain ids (got ${JSON.stringify(demo)})`);

  const errors = [...a.errors, ...b.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: patient number (visual_id) cross-device browser test passed`);
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
