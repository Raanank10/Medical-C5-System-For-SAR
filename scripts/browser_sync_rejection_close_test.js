// Real-browser test of closing sync rejections (gap N7, database/071, V2.99.55). A CC and a medic
// (two browser contexts, so two devices) share one fake backend, the harness of
// scripts/browser_remote_vitals_test.js. The fake keeps sync_ingestion_errors, answers
// resolve_sync_ingestion_error with 071's checks, and closes a rejection when the same
// device_id + local_event_id is later accepted, as 071's trigger does. It proves client behavior
// only; database/071 itself was verified against the live Postgres.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_sync_rejection_close_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
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
const ALLOWED = { medic: ['VITALS_RECORDED', 'PATIENT_TRIAGE_UPDATED', 'PATIENT_STATUS_UPDATED', 'INTERVENTION_RECORDED', 'MEDICATION_ADMINISTERED', 'AIRWAY_MANAGED'], cc: [] };

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [MEDIC].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    events: [],
    errors: [],
    resolveCalls: [],
    rejected: [],
  };
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    const evId = `ev-${server.events.length + 1}`;
    server.events.push({ ...e, id: evId, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId, actor_role: u.role });
    // database/071 trigger: a later accepted event closes its open rejections.
    server.errors.filter((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id && !x.resolved_at).forEach((x) => { x.resolved_at = new Date().toISOString(); x.reconciled_event_id = evId; x.resolution_notes = 'auto'; });
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
    if (req.name === 'resolve_sync_ingestion_error') {
      server.resolveCalls.push({ role: u.role, ...p });
      if (!['pc', 'cc', 'chamal', 'physician', 'admin'].includes(u.role)) return { data: null, error: { message: 'only command roles', code: '42501' } };
      if (!['resent', 'duplicate', 'test_data', 'not_recoverable', 'other'].includes(p.p_reason)) return { data: null, error: { message: 'unknown reason' } };
      if (['not_recoverable', 'other'].includes(p.p_reason) && !(p.p_note || '').trim()) return { data: null, error: { message: 'note required' } };
      const row = server.errors.find((x) => x.id === p.p_id);
      if (!row) return { data: null, error: { message: 'not found' } };
      if (row.resolved_at) return { data: { id: row.id, changed: false }, error: null };
      row.resolved_at = new Date().toISOString(); row.resolved_by = u.id; row.resolution_notes = p.p_reason + (p.p_note ? ': ' + p.p_note : '');
      return { data: { id: row.id, changed: true }, error: null };
    }
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
  if (req.table === 'sync_ingestion_errors') {
    // Read policy: command roles of the incident; the client asks for unresolved rows only.
    if (!['pc', 'cc', 'chamal', 'physician', 'admin'].includes(u.role)) return { data: [], error: null };
    const rows = server.errors.filter((x) => !x.resolved_at && server.incidents.some((i) => i.id === x.incident_id && canSee(i))).filter(match)
      .map((x) => ({ id: x.id, incident_id: x.incident_id, device_id: x.device_id, local_event_id: x.local_event_id, error_code: x.error_code, error_message: x.error_message, dependency_status: null, created_at: x.created_at, event_type: x.raw_payload?.type ?? null }));
    return { data: clone(rows), error: null };
  }
  if (req.table === 'events') {
    // events read policy: members (and blanket command roles) of the incident.
    const rows = server.events.filter((e) => server.incidents.some((i) => i.id === e.incident_id && canSee(i))).filter(match)
      .sort((a, b) => Date.parse(b.local_timestamp) - Date.parse(a.local_timestamp))
      .map((e) => ({ patient_id: e.patient_id, device_id: e.device_id, actor_role: e.actor_role, local_timestamp: e.local_timestamp, payload_json: e.payload_json }));
    return { data: clone(req.limit ? rows.slice(0, req.limit) : rows), error: null };
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

async function pullVitals(page) {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullRemoteVitals(id))));
  await page.waitForTimeout(200);
}
const addPatients = (page) => page.evaluate(([a, b]) => {
  for (const id of [a, b]) patients.push({ id, visualId: id === a ? 'P-VT' : 'P-OTHER', triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], txHistory: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], time: '10:00', sourcedFromRemote: true });
}, [PATIENT, OTHER]);
const vitalsOf = (page, pid) => page.evaluate((id) => { const p = patients.find((x) => x.id === id); return { ...p.vitals, from: p.vitalsFrom || null, history: (p.vitalsHistory || []).length }; }, pid);
async function panelRows(page) {
  await page.evaluate(() => pullSyncIngestionErrorsAll());
  await page.waitForTimeout(250);
  await page.evaluate(() => goTo('commander'));
  await page.waitForTimeout(250);
  if (!(await page.evaluate(() => !!cmdPanelOpen.quarantine))) await page.click('button.cmd-panel-toggle:has-text("אירועים חסומים")');
  return page.evaluate(() => [...document.querySelectorAll('#cmd-quarantine-panel .sync-rejection-row')].map((r) => ({ id: r.dataset.rejectionId, text: r.textContent.replace(/\s+/g, ' ').trim() })));
}

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
  const at = new Date(Date.now() - 600000).toISOString();
  SERVER.errors.push(
    { id: 'err-test', incident_id: INC1, device_id: 'TEST-DEVICE-9', local_event_id: 'old-1', error_code: 'FORBIDDEN_ACTOR_ROLE', error_message: 'Role cannot write <img src=x onerror=window.__xss=1>', raw_payload: { type: 'MEDICATION_ADMINISTERED' }, created_at: at },
    { id: 'err-lost', incident_id: INC1, device_id: 'PHONE-LOST', local_event_id: 'old-2', error_code: 'PATIENT_CREATE_FAILED', error_message: 'new row violates row-level security policy', raw_payload: { type: 'QUICK_PATIENT_CREATED' }, created_at: at });

  const cc = await phone();
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  const m = await phone();
  await login(m.page, 'medic@test');
  await enter(m.page);
  await addPatients(m.page);

  // 1. The CC's panel lists both, with the record type; text from a payload carries no markup.
  let rows = await panelRows(cc.page);
  assert(rows.length === 2 && rows.some((r) => r.text.includes('QUICK_PATIENT_CREATED')), `${rel}: CC must see both rejections with their record type (got ${JSON.stringify(rows)})`);
  assert(!(await cc.page.evaluate(() => window.__xss)) && (await cc.page.locator('#cmd-quarantine-panel img').count()) === 0, `${rel}: an error message must be shown as text, not markup`);

  // 2. Closing needs a reason; "not recoverable" needs a note; the sheet warns about the nightly deletion.
  await cc.page.click('#cmd-quarantine-panel [data-rejection-id="err-lost"] button:has-text("סגור")');
  await cc.page.waitForSelector('#sync-rejection-modal:not(.hidden)');
  assert((await cc.page.textContent('#sync-rejection-modal')).includes('יימחק מהשרת בלילה'), `${rel}: the sheet must warn that the stored copy is deleted overnight`);
  await cc.page.click('#sync-rejection-confirm');
  await cc.page.click('#sync-rejection-reasons button[data-reason="not_recoverable"]');
  await cc.page.click('#sync-rejection-confirm');
  assert(SERVER.resolveCalls.length === 0, `${rel}: no reason, or "not recoverable" without a note, must not reach the server`);
  await cc.page.fill('#sync-rejection-note', 'הטלפון אבד בתרגיל');
  await cc.page.click('#sync-rejection-confirm');
  await cc.page.waitForTimeout(300);
  const lost = SERVER.errors.find((x) => x.id === 'err-lost');
  assert(lost.resolved_at && lost.resolution_notes === 'not_recoverable: הטלפון אבד בתרגיל' && lost.resolved_by === CC, `${rel}: the close must reach the server with reason and note (got ${JSON.stringify(lost)})`);
  rows = await panelRows(cc.page);
  assert(rows.length === 1 && rows[0].id === 'err-test', `${rel}: the closed rejection leaves the panel (got ${JSON.stringify(rows)})`);

  // 3. A rejection closes by itself when the phone resends the record and the server accepts it.
  SERVER.errors.push({ id: 'err-resend', incident_id: INC1, device_id: null, local_event_id: 'resend-1', error_code: 'MALFORMED_EVENT_ENVELOPE', error_message: 'events_patient_id_fkey', raw_payload: { type: 'VITALS_RECORDED' }, created_at: at });
  const dev = await m.page.evaluate(() => getDeviceId());
  SERVER.errors[SERVER.errors.length - 1].device_id = dev;
  await m.page.evaluate(async (pid) => {
    saveLocalEvent({ type: 'VITALS_RECORDED', patient_id: pid, detail: 'resend', payload_json: { pulse: 90 } });
    const out = getOutbox(); const e = out[out.length - 1];
    e.local_event_id = 'resend-1'; e.synced = true; e.syncRejected = true; e.syncRejectReason = 'MALFORMED_EVENT_ENVELOPE';
    await persistOutbox();
  }, PATIENT);
  assert((await panelRows(cc.page)).some((r) => r.id === 'err-resend'), `${rel}: the new rejection is listed`);
  await m.page.evaluate((pid) => retryPatientSync(pid), PATIENT);
  await m.page.waitForTimeout(400);
  const resent = SERVER.errors.find((x) => x.id === 'err-resend');
  assert(resent.resolved_at && resent.reconciled_event_id, `${rel}: a resent and accepted record closes its rejection (got ${JSON.stringify(resent)})`);
  rows = await panelRows(cc.page);
  assert(rows.length === 1 && rows[0].id === 'err-test', `${rel}: it leaves the CC's panel (got ${JSON.stringify(rows)})`);

  // 4. A medic sees no rejections panel rows and cannot close one.
  assert((await panelRows(m.page)).length === 0, `${rel}: a medic is not shown rejections`);

  const errors = [...m.errors, ...cc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: sync rejection close browser test passed`);
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
