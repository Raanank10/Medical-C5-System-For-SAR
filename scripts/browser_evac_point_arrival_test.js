// Real-browser test of WP-18 (V2.99.65, database/075-076): moving to the site's evacuation point
// vs arrived there, and how long patients wait for MDA. Two medics, a PC and a CC (four tabs, one
// browser context) share one fake backend in this Node process, the same harness as
// scripts/browser_evacuation_tracking_test.js. The fake answers sync-log with its role gating
// (PATIENT_EVAC_POINT_ARRIVED is a clinical event: medic/paramedic/physician/pc/admin) and mirrors
// database/076: arrival from the phone's time, earliest wins, never later than the server clock,
// cleared when a later on-scene status takes the patient back. It proves client behavior only.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_evac_point_arrival_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const PC = '22222222-2222-4222-8222-222222222222';
const CC = '33333333-3333-4333-8333-333333333333';
const MEDIC = '11111111-1111-4111-8111-111111111111';
const MEDIC2 = '44444444-4444-4444-8444-444444444444';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש בדיקה' },
  'medic2@test': { id: MEDIC2, role: 'medic', display_name: 'חובש שני' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const MDA = ['minor', 'anxiety', 'moderate', 'serious', 'critical', 'deceased'];
const CLINICAL = ['PATIENT_CREATED', 'QUICK_PATIENT_CREATED', 'PATIENT_LOCATION_UPDATED', 'PATIENT_TRIAGE_UPDATED',
  'PATIENT_STATUS_UPDATED', 'PATIENT_HANDED_OVER', 'PATIENT_TRIAGED_EXPECTANT', 'VITALS_RECORDED', 'TOURNIQUET_APPLIED',
  'INTERVENTION_RECORDED', 'AIRWAY_MANAGED', 'PATIENT_EVAC_POINT_ARRIVED'];
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
      { incident_id: INC1, profile_id: MEDIC2, role_at_incident: 'medic', assigned_by: null, created_at: new Date().toISOString() },
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
      server.patients.push({ id: e.patient_id, incident_id: body.incident_id, visual_id: pj.visual_id || e.local_event_id, current_triage: 'pending', current_status: 'identified', access_status: 'unknown', needs_full_assessment: false, is_pediatric: false, version: 1, location_json: {}, location_recorded_at: null, evacuation_destination: null, mda_classification: null, evacuation_updated_at: null, evac_point_arrived_at: null, evac_point_arrived_role: null, evac_point_cleared_at: null });
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
    if (p && e.type === 'PATIENT_STATUS_UPDATED' && pj.status) {
      p.current_status = pj.status; p.version++;
      // database/076: a later status that is neither evacuating nor final takes the patient back.
      if (!['evacuating', 'handed_over', 'deceased', 'closed', 'self_evacuated'].includes(p.current_status)
        && (!p.evac_point_cleared_at || Date.parse(p.evac_point_cleared_at) < ts)) {
        if (p.evac_point_arrived_at && Date.parse(p.evac_point_arrived_at) < ts) { p.evac_point_arrived_at = null; p.evac_point_arrived_role = null; }
        p.evac_point_cleared_at = e.local_timestamp;
      }
    }
    // database/076: earliest phone time wins, never later than the server clock, ignored if
    // recorded before the patient was taken back from the point.
    if (p && e.type === 'PATIENT_EVAC_POINT_ARRIVED') {
      const at = Math.min(ts, Date.now());
      if ((!p.evac_point_arrived_at || Date.parse(p.evac_point_arrived_at) > at) && (!p.evac_point_cleared_at || Date.parse(p.evac_point_cleared_at) < at)) {
        p.evac_point_arrived_at = new Date(at).toISOString(); p.evac_point_arrived_role = u.role; p.version++;
      }
    }
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
    && (req.notNull || []).every((c) => row[c] != null)
    && (!req.anyNotNull || req.anyNotNull.some((c) => row[c] != null));
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
    const q={kind:'from',table,op:'select',eq:{},in:{},notNull:[],anyNotNull:null,single:false,order:null,limit:null,payload:null,ignoreDup:false};
    const b={};
    b.select=()=>b; b.eq=(c,v)=>{ q.eq[c]=v; return b; }; b.in=(c,v)=>{ q.in[c]=v; return b; };
    b.not=(c,op,v)=>{ if(op==='is'&&v===null) q.notNull.push(c); return b; };
    b.or=(f)=>{ q.anyNotNull=String(f).split(',').map(x=>x.replace(/\.not\.is\.null$/,'')); return b; };
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

const boardText = async (page, role) => {
  await page.evaluate((r) => startRoleDashboard(r), role);
  await page.waitForTimeout(250);
  return (await page.textContent('#role-dashboard-body')).replace(/\s+/g, ' ');
};

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // Medic 1 registers a red casualty and sends it out of the extraction site with the bar button.
  const m1 = await openPhone(context, file);
  await login(m1.page, 'medic@test');
  await enter(m1.page);
  const id = await m1.page.evaluate(() => { siteData.currentZone = 'קומה 2'; createImmediateInterventionPatient('airway'); return patients[0].id; });
  await syncAll(m1.page); await syncAll(m1.page);
  await m1.page.evaluate((pid) => openPatient(pid), id);
  await m1.page.click('#detail-bottom-bar button:has-text("יצא לנקודת פינוי")');
  await m1.page.waitForTimeout(150);
  assert(await m1.page.locator('#detail-bottom-bar button:has-text("הגיע לנקודת פינוי")').isVisible(),
    `${rel}: on the way to the evacuation point, the bar must offer "הגיע לנקודת פינוי"`);
  assert(await m1.page.evaluate((pid) => patientStatusLabel(patients.find((p) => p.id === pid)), id) === 'בדרך לנקודת פינוי',
    `${rel}: a patient sent to the evacuation point reads "בדרך לנקודת פינוי" until the arrival`);
  await syncAll(m1.page);
  let sp = SERVER.patients.find((p) => p.id === id);
  assert(sp.current_status === 'evacuating' && !sp.evac_point_arrived_at, `${rel}: the server has the patient moving, not arrived`);

  // PC phone (another device): the board shows the patient on the way, with an arrival button.
  const pc = await openPhone(context, file);
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  await pullAll(pc.page);
  let pcBoard = await boardText(pc.page, 'pc');
  assert(pcBoard.includes('🚶 בדרך לנקודת הפינוי') && pcBoard.includes('בדרך 1') && pcBoard.includes('בנקודת פינוי 0'),
    `${rel}: the PC board must show the patient on the way, not at the point (got ${pcBoard.slice(pcBoard.indexOf('בזירה'), pcBoard.indexOf('בזירה') + 200)})`);
  assert(await pc.page.locator('#role-dashboard-body .evac-arrived-btn').count() === 1, `${rel}: the PC is offered "הגיע לנקודה" on the board`);

  // Medic 2, offline, records the arrival 6 minutes ago (its push comes late, below).
  const m2 = await openPhone(context, file);
  await login(m2.page, 'medic2@test');
  await enter(m2.page);
  await pullAll(m2.page);
  await m2.page.evaluate((pid) => markPatientArrivedAtEvacPoint(pid), id);
  const sixMinAgo = new Date(Date.now() - 6 * 60000).toISOString();
  await m2.page.evaluate((at) => {
    const e = state.localEvents.find((x) => x.type === 'PATIENT_EVAC_POINT_ARRIVED');
    e.local_timestamp = at; e.payload_json.arrived_at = at;
  }, sixMinAgo);

  // The PC marks the arrival now from its board and pushes first.
  await pc.page.click('#role-dashboard-body .evac-arrived-btn');
  await syncAll(pc.page);
  sp = SERVER.patients.find((p) => p.id === id);
  assert(sp.evac_point_arrived_at && sp.evac_point_arrived_role === 'pc', `${rel}: the PC's arrival must reach the server`);
  // Medic 2 comes back online: its earlier arrival time wins.
  await syncAll(m2.page);
  sp = SERVER.patients.find((p) => p.id === id);
  assert(sp.evac_point_arrived_at === sixMinAgo && sp.evac_point_arrived_role === 'medic',
    `${rel}: a late push keeps the original (earlier) arrival time (got ${sp.evac_point_arrived_at} vs ${sixMinAgo})`);
  assert(!SERVER.rejected.length, `${rel}: no event may be rejected (got ${JSON.stringify(SERVER.rejected)})`);

  // CC phone: cannot mark, sees the stage and the waiting time from the server.
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await pullAll(cc.page);
  const ccBoard = await boardText(cc.page, 'cc');
  assert(ccBoard.includes('בנקודת פינוי 1 (עד 6 דק׳)') && ccBoard.includes('🚑 ממתינים לפינוי מד״א · עד 6 דק׳'),
    `${rel}: CC must see the patient waiting at the evacuation point for 6 minutes (got ${ccBoard.slice(ccBoard.indexOf('בזירה'), ccBoard.indexOf('בזירה') + 260)})`);
  assert(ccBoard.includes('בנקודת פינוי · ממתין 6 דק׳'), `${rel}: the evacuation priority list shows the wait`);
  assert(!(await cc.page.evaluate((pid) => canMarkEvacPointArrival(patients.find((p) => p.id === pid)), id)), `${rel}: CC is not offered the arrival`);
  await cc.page.evaluate((pid) => openPatient(pid), id);
  assert((await cc.page.textContent('.evac-arrival-row') || '').includes('חובש'), `${rel}: the patient card says who recorded the arrival`);

  // Every phone reads the same: the PC and medic 1 pick up the earlier time on their next pull.
  await pullAll(pc.page); await pullAll(m1.page);
  for (const [name, page] of [['PC', pc.page], ['medic 1', m1.page]]) {
    const at = await page.evaluate((pid) => patients.find((p) => p.id === pid).evacPointArrivedAt, id);
    assert(at === Date.parse(sixMinAgo), `${rel}: ${name} phone must show the server's arrival time`);
  }
  pcBoard = await boardText(pc.page, 'pc');
  assert(pcBoard.includes('בדרך לנקודה') && pcBoard.includes('עד 6 דק׳'), `${rel}: the PC funnel shows four stages and the longest wait`);

  // Taken back from the point (a later on-scene status): the server clears the arrival and the
  // phones follow on the next pull.
  const later = new Date().toISOString();
  Object.assign(SERVER.patients.find((p) => p.id === id), { current_status: 'stabilizing', evac_point_arrived_at: null, evac_point_arrived_role: null, evac_point_cleared_at: later, version: sp.version + 1 });
  await pullAll(cc.page);
  assert(await cc.page.evaluate((pid) => { const p = patients.find((x) => x.id === pid); return p.evacPointArrivedAt === null && evacuationStage(p) === 'on_scene'; }, id),
    `${rel}: a cleared arrival must be cleared on the phone`);

  const errors = [...m1.errors, ...m2.errors, ...pc.errors, ...cc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: evacuation point arrival (WP-18) cross-device browser test passed`);
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
