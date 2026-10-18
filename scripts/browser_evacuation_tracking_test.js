// Real-browser test of evacuation tracking and the casualty board by location (V2.99.31): a PC,
// a CC and a medic phone (three tabs, one browser context) share one fake backend in this Node
// process, reached through a Playwright binding, the same harness as
// scripts/browser_medic_assignment_test.js. The fake also answers the sync-log Edge Function and
// mirrors what the real server does with the events this feature sends:
// - role gating as in supabase/functions/sync-log/index.ts (PATIENT_EVACUATION_UPDATED and
//   EXTERNAL_REPORT_CREATED: pc/cc/chamal/physician/admin; clinical events: medic/pc/...)
// - projection as in database/044 (destination + MDA classification, newest local_timestamp wins,
//   never touching triage/status) and database/041's PATIENT_LOCATION_UPDATED branch.
// It proves client behavior only; database/044 itself was exercised against a real Postgres.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_evacuation_tracking_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html'), path.join(root, 'demo', 'rescue-app.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const PC = '22222222-2222-4222-8222-222222222222';
const CC = '33333333-3333-4333-8333-333333333333';
const MEDIC = '11111111-1111-4111-8111-111111111111';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש בדיקה' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const MDA = ['minor', 'anxiety', 'moderate', 'serious', 'critical', 'deceased'];
const CLINICAL = ['PATIENT_CREATED', 'QUICK_PATIENT_CREATED', 'PATIENT_LOCATION_UPDATED', 'PATIENT_TRIAGE_UPDATED',
  'PATIENT_STATUS_UPDATED', 'PATIENT_HANDED_OVER', 'PATIENT_TRIAGED_EXPECTANT', 'VITALS_RECORDED', 'TOURNIQUET_APPLIED',
  'INTERVENTION_RECORDED', 'AIRWAY_MANAGED'];
const ALLOWED = {
  pc: [...CLINICAL, 'EXTERNAL_REPORT_CREATED', 'PATIENT_EVACUATION_UPDATED'],
  cc: ['EXTERNAL_REPORT_CREATED', 'PATIENT_EVACUATION_UPDATED'],
  medic: [...CLINICAL],
};

function newServer() {
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [
      { incident_id: INC1, profile_id: PC, role_at_incident: 'pc', assigned_by: null, created_at: new Date().toISOString() },
      { incident_id: INC1, profile_id: MEDIC, role_at_incident: 'medic', assigned_by: null, created_at: new Date().toISOString() },
    ],
    patients: [],
    events: [],
    external_reports: [],
    rejected: [],
  };
}

// sync-log POST: role gate, create patient rows, insert, project (database/041 + 044 subset).
function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    const pj = e.payload_json || {};
    if (['PATIENT_CREATED', 'QUICK_PATIENT_CREATED'].includes(e.type) && e.patient_id && !server.patients.some((p) => p.id === e.patient_id)) {
      server.patients.push({ id: e.patient_id, incident_id: body.incident_id, visual_id: pj.visual_id || e.local_event_id, current_triage: 'pending', current_status: 'identified', access_status: 'unknown', needs_full_assessment: false, is_pediatric: false, version: 1, location_json: {}, location_recorded_at: null, evacuation_destination: null, mda_classification: null, evacuation_updated_at: null });
    }
    const p = server.patients.find((x) => x.id === e.patient_id);
    if (e.patient_id && !p) { rejected.push({ local_event_id: e.local_event_id, terminal: false }); continue; }
    server.events.push({ ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId });
    const ts = Date.parse(e.local_timestamp);
    if (p && e.type === 'PATIENT_TRIAGE_UPDATED' && pj.triage) { p.current_triage = pj.triage; p.version++; }
    if (p && e.type === 'PATIENT_LOCATION_UPDATED' && pj.location && (!p.location_recorded_at || ts >= Date.parse(p.location_recorded_at))) {
      p.location_json = pj.location; p.location_recorded_at = e.local_timestamp; p.version++;
    }
    if (p && e.type === 'PATIENT_HANDED_OVER') { p.current_status = 'handed_over'; p.version++; }
    if (p && ['PATIENT_HANDED_OVER', 'PATIENT_EVACUATION_UPDATED'].includes(e.type)) {
      let dest = (pj.destination_facility || '').trim() || null; if (dest === 'pending') dest = null;
      const mda = MDA.includes(pj.mda_classification) ? pj.mda_classification : null;
      if ((dest || mda) && (!p.evacuation_updated_at || Date.parse(p.evacuation_updated_at) <= ts)) {
        p.evacuation_destination = dest || p.evacuation_destination; p.mda_classification = mda || p.mda_classification;
        p.evacuation_updated_at = e.local_timestamp; p.version++;
      }
    }
    if (e.type === 'EXTERNAL_REPORT_CREATED') {
      const source = ['mda', 'united_hatzalah', 'yedidim', 'police', 'idf', 'civilian', 'other'].includes(pj.source) ? pj.source : 'other';
      server.external_reports.push({ id: `er-${server.external_reports.length + 1}`, incident_id: body.incident_id, source, reported_red: pj.reported_red || 0, reported_yellow: pj.reported_yellow || 0, reported_green: pj.reported_green || 0, reported_black: 0, evacuation_destination: pj.evacuation_destination || null, notes: pj.notes || null, external_reference: pj.external_reference || null, created_at: new Date().toISOString() });
    }
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
    if (req.name === 'join_incident') {
      if (!server.members.some((m) => m.incident_id === p.p_incident_id && m.profile_id === u.id)) server.members.push({ incident_id: p.p_incident_id, profile_id: u.id, role_at_incident: u.role, assigned_by: null, created_at: new Date().toISOString() });
      return { data: { id: p.p_incident_id }, error: null };
    }
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true })).filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const visible = server.incidents.filter((i) => canSee(i) && match(i));
    if (req.op === 'update') return { data: [], error: null };
    const data = req.single ? (visible[0] || null) : visible;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') return { data: null, error: null };
    let vis = server.members.filter((r) => r.profile_id === u.id || ['pc', 'cc'].includes(u.role)).filter(match);
    if (req.limit) vis = vis.slice(0, req.limit);
    return { data: clone(req.single ? (vis[0] || null) : vis), error: null };
  }
  if (req.table === 'patients' || req.table === 'external_reports') {
    const rows = server[req.table].filter((r) => server.incidents.some((i) => i.id === r.incident_id && canSee(i))).filter(match);
    return { data: clone(req.single ? (rows[0] || null) : rows), error: null };
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

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // PC phone: two casualties in two zones of one site.
  const pc = await openPhone(context, file);
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  const [idA, idB] = await pc.page.evaluate(() => {
    siteData.name = 'מוקד בדיקה'; siteData.address = 'רחוב בדיקה 1';
    siteData.currentZone = 'קומה 2'; createImmediateInterventionPatient('airway'); const a = patients[0].id;
    siteData.currentZone = 'חניון'; createImmediateInterventionPatient('airway'); const b = patients[0].id;
    return [a, b];
  });
  await syncAll(pc.page);
  await syncAll(pc.page); // second push carries the location/triage the reconcilers queue once the patient exists
  let pA = SERVER.patients.find((p) => p.id === idA);
  assert(pA && pA.location_json.detail === 'קומה 2', `${rel}: patient A's zone must reach the server (got ${JSON.stringify(pA?.location_json)})`);
  assert(SERVER.patients.find((p) => p.id === idB)?.location_json.detail === 'חניון', `${rel}: patient B's zone must reach the server`);

  // Handover of A through the real sheet: destination + MDA classification.
  await pc.page.evaluate((id) => openPatient(id), idA);
  await pc.page.click('#detail-bottom-bar button:has-text("הועבר למד״א — עכשיו")');
  await pc.page.waitForSelector('#evac-sheet-modal:not(.hidden)');
  await pc.page.fill('#evac-sheet-dest', 'שיבא');
  await pc.page.click('#evac-sheet-mda button[data-mda="serious"]');
  await pc.page.click('#evac-sheet-confirm');
  await syncAll(pc.page);
  const ho = SERVER.events.find((e) => e.type === 'PATIENT_HANDED_OVER' && e.patient_id === idA);
  assert(ho && ho.payload_json.destination_facility === 'שיבא' && ho.payload_json.mda_classification === 'serious', `${rel}: handover must carry destination + MDA classification`);
  assert(!JSON.stringify(ho.payload_json).includes('pending'), `${rel}: handover must not send the old 'pending' placeholder`);
  pA = SERVER.patients.find((p) => p.id === idA);
  assert(pA.current_status === 'handed_over' && pA.evacuation_destination === 'שיבא' && pA.mda_classification === 'serious', `${rel}: server must project A's evacuation`);

  // United Hatzalah external report, entered on the PC phone.
  await pc.page.evaluate(() => { prepareExternalReport(); goTo('add-report'); });
  await pc.page.click('#report-source-grid button:has-text("איחוד הצלה")');
  await pc.page.evaluate(() => { changeRC('red', 1); changeRC('red', 1); changeRC('green', 1); });
  await pc.page.fill('#report-evac-dest', 'איכילוב');
  await pc.page.click('#btn-save-report');
  await syncAll(pc.page);
  const er = SERVER.external_reports[0];
  assert(er && er.source === 'united_hatzalah' && er.reported_red === 2 && er.reported_green === 1 && er.evacuation_destination === 'איכילוב', `${rel}: UH report must reach external_reports (got ${JSON.stringify(er)})`);
  assert(await pc.page.locator('#report-source-grid button:has-text("ידידים")').count() === 1, `${rel}: Yedidim stays a separate source`);

  // CC phone (another device): its dashboard board shows site -> zone, destination + MDA, and the UH report.
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await pullAll(cc.page);
  assert(await cc.page.evaluate((id) => patients.find((p) => p.id === id)?.sourcedFromRemote === true, idB), `${rel}: CC's copy of B must come from sync, not shared storage`);
  await cc.page.evaluate(() => startRoleDashboard('cc'));
  await cc.page.waitForTimeout(250);
  let board = (await cc.page.textContent('#role-dashboard-body')).replace(/\s+/g, ' ');
  assert(board.includes('לוח נפגעים לפי מיקום'), `${rel}: CC dashboard must show the location board`);
  assert(board.includes('📍 חניון'), `${rel}: CC must see B under its zone from the other phone (got ${board.slice(board.indexOf('לוח נפגעים'), board.indexOf('לוח נפגעים') + 400)})`);
  assert(board.includes('🏥 שיבא') && board.includes('מד״א: קשה'), `${rel}: CC must see A's destination and MDA classification`);
  assert(board.includes('איחוד הצלה'), `${rel}: CC must see the United Hatzalah report`);

  // CC updates A's MDA classification later; it reaches the server and the PC phone.
  await cc.page.locator('#role-dashboard-body button:has-text("עדכן")').first().click();
  await cc.page.waitForSelector('#evac-sheet-modal:not(.hidden)');
  assert((await cc.page.inputValue('#evac-sheet-dest')) === 'שיבא', `${rel}: update sheet must prefill the known destination`);
  await cc.page.click('#evac-sheet-mda button[data-mda="critical"]');
  await cc.page.click('#evac-sheet-confirm');
  await syncAll(cc.page);
  pA = SERVER.patients.find((p) => p.id === idA);
  assert(pA.mda_classification === 'critical' && pA.evacuation_destination === 'שיבא', `${rel}: CC's update must project (got ${pA.mda_classification}/${pA.evacuation_destination})`);
  assert(pA.current_triage === 'red', `${rel}: an MDA classification must never change field triage`);
  assert(!SERVER.rejected.length, `${rel}: no event may be rejected (got ${JSON.stringify(SERVER.rejected)})`);

  await pullAll(pc.page);
  assert(await pc.page.evaluate((id) => patients.find((p) => p.id === id)?.mdaClassification, idA) === 'critical', `${rel}: PC phone must receive CC's MDA update`);
  await pc.page.evaluate(() => goTo('commander'));
  await pc.page.waitForTimeout(250);
  const cmd = (await pc.page.textContent('#cmd-location-board')).replace(/\s+/g, ' ');
  assert(cmd.includes('📍 חניון') && cmd.includes('🏥 שיבא') && cmd.includes('מד״א: אנוש'), `${rel}: PC command screen board must show zone, destination and the updated MDA classification`);

  // Mismatch flag is informational: MDA 'minor' on a red patient is flagged, triage untouched.
  await pc.page.evaluate((id) => updatePatientEvacuation(id, { mdaClassification: 'minor' }), idA);
  await syncAll(pc.page);
  await pc.page.evaluate(() => goTo('commander'));
  await pc.page.waitForTimeout(200);
  assert((await pc.page.textContent('#cmd-location-board')).includes('שונה ממיון שדה'), `${rel}: MDA vs field triage mismatch must be flagged`);
  assert(await pc.page.evaluate((id) => patients.find((p) => p.id === id).triage, idA) === 'red', `${rel}: mismatch must not change local triage`);

  // A medic phone: no later evacuation update offered, even by calling it directly.
  const medic = await openPhone(context, file);
  await login(medic.page, 'medic@test');
  await enter(medic.page);
  assert(!(await medic.page.evaluate(() => canUpdateEvacuationTracking())), `${rel}: a medic must not be offered the later evacuation update`);
  await medic.page.evaluate((id) => updatePatientEvacuation(id, { destination: 'X', mdaClassification: 'minor' }), idA);
  await syncAll(medic.page);
  const medicEvac = SERVER.events.filter((e) => e.type === 'PATIENT_EVACUATION_UPDATED' && e.actor_id === MEDIC).length
    + SERVER.rejected.filter((r) => r.role === 'medic').length;
  assert(medicEvac === 0, `${rel}: a medic must not send PATIENT_EVACUATION_UPDATED (not even a rejected attempt)`);

  // Text another user typed reaches this phone stripped of markup characters.
  SERVER.patients.find((p) => p.id === idB).location_json = { zone: '<img src=x onerror=window.__xss=1>חניון', detail: 'חניון' };
  SERVER.patients.find((p) => p.id === idB).location_recorded_at = new Date().toISOString();
  await pullAll(cc.page);
  const zoneB = await cc.page.evaluate((id) => patients.find((p) => p.id === id).zone, idB);
  assert(!/[<>]/.test(zoneB) && !(await cc.page.evaluate(() => window.__xss)), `${rel}: remote zone must arrive without markup (got ${zoneB})`);

  const errors = [...pc.errors, ...cc.errors, ...medic.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: evacuation tracking + location board cross-device browser test passed`);
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
