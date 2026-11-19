// Real-browser test of WP-23 (V2.99.76, database/088): injury time, editable in the field.
// Two medics, a PC and a CC (four tabs, one browser context) share one fake backend in this Node
// process, the harness of scripts/browser_evac_point_arrival_test.js. The fake mirrors
// database/088: the create event gives the patient the incident's alert time ('incident_open');
// PATIENT_T_INJURY_UPDATED is applied for medic/paramedic/physician/pc/admin only, within 5 minutes
// after and 26 hours before the entry, and the newest entry by phone time wins. It proves client
// behavior only; the SQL itself was tested on a local PostgreSQL (see the 088 header).
//
// Checks: estimated time shown as "(משוערת)" from T0; the 4-digit entry (same control as the
// tourniquet body time) sends the event and the server marks it entered; other phones show it; an
// older entry pushed late by an offline phone does not win; CC gets no edit button and the server
// would refuse its event; the command watchdog's Golden Hour row counts from the injury time; MIST
// says the injury time and no longer repeats the injuries as the mechanism; the stored report shows
// the golden-hour box (and says so when a report has none); a database without 088 breaks nothing.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_injury_time_test.js
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
const T0 = new Date(Date.now() - 30 * 60000).toISOString(); // the incident's alert time, 30 minutes ago

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
  'INTERVENTION_RECORDED', 'AIRWAY_MANAGED', 'PATIENT_EVAC_POINT_ARRIVED', 'PATIENT_T_INJURY_UPDATED'];
const ALLOWED = {
  pc: [...CLINICAL, 'EXTERNAL_REPORT_CREATED', 'PATIENT_EVACUATION_UPDATED'],
  cc: ['EXTERNAL_REPORT_CREATED', 'PATIENT_EVACUATION_UPDATED'],
  medic: [...CLINICAL],
};

function newServer() {
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {}, t_zero: T0, t_injury_default: T0 }],
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
      server.patients.push({ id: e.patient_id, incident_id: body.incident_id, visual_id: pj.visual_id || e.local_event_id, current_triage: 'pending', current_status: 'identified', access_status: 'unknown', needs_full_assessment: false, is_pediatric: false, version: 1, location_json: {}, location_recorded_at: null, evacuation_destination: null, mda_classification: null, evacuation_updated_at: null, evac_point_arrived_at: null, evac_point_arrived_role: null, evac_point_cleared_at: null, t_injury: e.local_timestamp, t_injury_source: 'event_time', t_injury_recorded_at: null, t_injury_set_by_role: null });
    }
    const p = server.patients.find((x) => x.id === e.patient_id);
    if (e.patient_id && !p) { rejected.push({ local_event_id: e.local_event_id, terminal: false }); continue; }
    server.events.push({ ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId });
    const ts = Date.parse(e.local_timestamp);
    // database/088: the create event gives a row still at 'event_time' the incident's alert time.
    if (p && ['PATIENT_CREATED', 'QUICK_PATIENT_CREATED'].includes(e.type) && p.t_injury_source === 'event_time' && !p.t_injury_recorded_at) {
      const inc = server.incidents.find((i) => i.id === p.incident_id);
      if (inc?.t_injury_default) { p.t_injury = inc.t_injury_default; p.t_injury_source = 'incident_open'; p.version++; }
    }
    // database/088: medical roles only, a parseable time not more than 5 min after the entry nor
    // 26 h before it, and the newest entry by phone time wins.
    if (p && e.type === 'PATIENT_T_INJURY_UPDATED') {
      const at = Math.min(ts, Date.now());
      const t = Date.parse(pj.t_injury || '');
      if (['medic', 'paramedic', 'physician', 'pc', 'admin'].includes(u.role) && Number.isFinite(t)
        && t <= at + 5 * 60000 && t >= at - 26 * 3600000
        && (!p.t_injury_recorded_at || at >= Date.parse(p.t_injury_recorded_at))) {
        Object.assign(p, { t_injury: new Date(t).toISOString(), t_injury_source: 'entered', t_injury_recorded_at: new Date(at).toISOString(), t_injury_set_by_role: u.role });
        p.version++;
      }
    }
    if (p && e.type === 'PATIENT_TRIAGE_UPDATED' && pj.triage) { p.current_triage = pj.triage; p.version++; }
    if (p && e.type === 'PATIENT_LOCATION_UPDATED' && pj.location && (!p.location_recorded_at || ts >= Date.parse(p.location_recorded_at))) {
      p.location_json = pj.location; p.location_recorded_at = e.local_timestamp; p.version++;
    }
    if (p && e.type === 'PATIENT_HANDED_OVER') { p.current_status = 'handed_over'; p.version++; }
    if (p && e.type === 'PATIENT_STATUS_UPDATED' && pj.status) {
      p.current_status = pj.status; p.version++;
      // database/077: a later status that is neither evacuating nor final takes the patient back.
      if (!['evacuating', 'handed_over', 'deceased', 'closed', 'self_evacuated'].includes(p.current_status)
        && (!p.evac_point_cleared_at || Date.parse(p.evac_point_cleared_at) < ts)) {
        if (p.evac_point_arrived_at && Date.parse(p.evac_point_arrived_at) < ts) { p.evac_point_arrived_at = null; p.evac_point_arrived_role = null; }
        p.evac_point_cleared_at = e.local_timestamp;
      }
    }
    // database/077: earliest phone time wins, never later than the server clock, ignored if
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
  if (req.table === 'patients' && server.before088 && String(req.columns || '').includes('t_injury_source')) {
    return { data: null, error: { message: 'column patients.t_injury_source does not exist' } };
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
    b.select=(c)=>{ if(c) q.columns=c; return b; }; b.eq=(c,v)=>{ q.eq[c]=v; return b; }; b.in=(c,v)=>{ q.in[c]=v; return b; };
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

const boardText = async (page, role) => {
  await page.evaluate((r) => startRoleDashboard(r), role);
  await page.waitForTimeout(250);
  return (await page.textContent('#role-dashboard-body')).replace(/\s+/g, ' ');
};

let SERVER = null;

const hhmmAgo = (page, minutes) => page.evaluate((m) => { const d = new Date(Date.now() - m * 60000); return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); }, minutes);
async function enterInjuryTime(page, pid, code) {
  await page.evaluate((id) => openPatient(id), pid);
  await page.click(`[data-injury-time-edit="${pid}"]`);
  await page.fill('#injury-time-entry-input', code);
  await page.click('[data-injury-time-action="save"]');
  await page.waitForTimeout(150);
}
const rowText = async (page, pid) => {
  await page.evaluate((id) => openPatient(id), pid);
  return ((await page.textContent(`[data-injury-time-row="${pid}"]`)) || '').replace(/\s+/g, ' ');
};

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // Medic 1 registers a casualty. Before any entry the injury time is the incident's alert time.
  const m1 = await openPhone(context, file);
  await login(m1.page, 'medic@test');
  await enter(m1.page);
  const id = await m1.page.evaluate(() => { siteData.currentZone = 'קומה 2'; createImmediateInterventionPatient('airway'); return patients[0].id; });
  const t0Hhmm = await m1.page.evaluate((t) => tourniquetHhmm(Date.parse(t)), T0);
  let row = await rowText(m1.page, id);
  assert(row.includes('שעת פציעה (משוערת)') && row.includes(t0Hhmm) && row.includes('משוערת · שעת ההתראה'),
    `${rel}: before an entry the patient screen shows the alert time as an estimate (got "${row}")`);
  await syncAll(m1.page); await syncAll(m1.page);
  let sp = SERVER.patients.find((p) => p.id === id);
  assert(sp && sp.t_injury_source === 'incident_open' && sp.t_injury === T0, `${rel}: the server gives the new patient the alert time (got ${JSON.stringify(sp && { s: sp.t_injury_source, t: sp.t_injury })})`);

  // A database without 088: the injury-time query fails on its own and nothing else breaks.
  SERVER.before088 = true;
  await pullAll(m1.page);
  SERVER.before088 = false;

  // Medic 1 enters the time from the field: 50 minutes ago.
  const code50 = await hhmmAgo(m1.page, 50);
  await enterInjuryTime(m1.page, id, code50);
  row = await rowText(m1.page, id);
  assert(row.includes('שעת פציעה') && !row.includes('(משוערת)') && row.includes(`${code50.slice(0, 2)}:${code50.slice(2)}`) && row.includes('הוזנה בשטח'),
    `${rel}: after the entry the row shows the entered time, not an estimate (got "${row}")`);
  const ev = await m1.page.evaluate(() => state.localEvents.filter((e) => e.type === 'PATIENT_T_INJURY_UPDATED').map((e) => e.payload_json));
  assert(ev.length === 1 && ev[0].t_injury && ev[0].previous_source === 'incident_open' && ev[0].time_code === code50,
    `${rel}: one PATIENT_T_INJURY_UPDATED with the ISO time and the previous source (got ${JSON.stringify(ev)})`);
  await syncAll(m1.page);
  sp = SERVER.patients.find((p) => p.id === id);
  const entered50 = Date.parse(ev[0].t_injury);
  assert(sp.t_injury_source === 'entered' && Date.parse(sp.t_injury) === entered50 && sp.t_injury_set_by_role === 'medic',
    `${rel}: the server marks the time entered by the medic`);

  // Golden Hour on the command watchdog counts from the injury time: 50 min = amber.
  const golden = await m1.page.evaluate((pid) => computeWatchdogRows(patients).find((r) => r.patient === pid && r.name === 'Golden Hour'), id);
  assert(golden && golden.state === 'amber' && golden.detail.startsWith('50 דק׳') && golden.detail.includes('מאז הפציעה') && !golden.detail.includes('משוערת'),
    `${rel}: Golden Hour counts from the entered injury time (got ${JSON.stringify(golden)})`);

  // MIST: the injury time is said; mechanism and injuries are no longer the same text.
  const mist = await m1.page.evaluate((pid) => mistTextForPatient(patients.find((p) => p.id === pid)), id);
  assert(mist.includes(`שעת פציעה: ${code50.slice(0, 2)}:${code50.slice(2)}, לפני 50 דק׳`) && !mist.includes('משוערת'),
    `${rel}: MIST says the entered injury time (got "${mist}")`);
  const mech = mist.match(/מנגנון: ([^.]*)\./)?.[1]; const inj = mist.match(/פציעות: ([^.]*)\./)?.[1];
  assert(mech && inj && mech !== inj, `${rel}: MIST mechanism and injuries must not repeat one field (got "${mech}" / "${inj}")`);

  // PC phone: reads the entered time from the server.
  const pc = await openPhone(context, file);
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  await pullAll(pc.page);
  row = await rowText(pc.page, id);
  assert(row.includes(`${code50.slice(0, 2)}:${code50.slice(2)}`) && row.includes('הוזנה בשטח') && row.includes('חובש') && !row.includes('(משוערת)'),
    `${rel}: the PC phone shows the medic's entered time (got "${row}")`);

  // Medic 2 is offline and enters 70 minutes ago, 10 minutes back by its phone time; the PC then
  // corrects to 55 minutes ago and pushes first. Medic 2's late push must not overwrite the PC.
  const m2 = await openPhone(context, file);
  await login(m2.page, 'medic2@test');
  await enter(m2.page);
  await pullAll(m2.page);
  await enterInjuryTime(m2.page, id, await hhmmAgo(m2.page, 70));
  const tenMinAgo = new Date(Date.now() - 10 * 60000).toISOString();
  await m2.page.evaluate((at) => { const e = state.localEvents.find((x) => x.type === 'PATIENT_T_INJURY_UPDATED'); e.local_timestamp = at; }, tenMinAgo);
  const code55 = await hhmmAgo(pc.page, 55);
  await enterInjuryTime(pc.page, id, code55);
  await syncAll(pc.page);
  sp = SERVER.patients.find((p) => p.id === id);
  const pcTime = sp.t_injury;
  assert(sp.t_injury_set_by_role === 'pc', `${rel}: the PC's correction reaches the server`);
  await syncAll(m2.page);
  sp = SERVER.patients.find((p) => p.id === id);
  assert(sp.t_injury === pcTime && sp.t_injury_set_by_role === 'pc', `${rel}: an older entry pushed late does not overwrite a newer correction`);
  assert(SERVER.events.filter((e) => e.type === 'PATIENT_T_INJURY_UPDATED').length === 3, `${rel}: all three entries stay in the event log`);
  // Medic 2's phone gives up its own (older) entry once the server holds a newer one.
  await pullAll(m2.page);
  assert(await m2.page.evaluate(([pid, t]) => patients.find((p) => p.id === pid).tInjury === Date.parse(t), [id, pcTime]),
    `${rel}: medic 2's phone follows the newer server time after the pull`);

  // CC: sees the time, cannot change it; the server would refuse the event.
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await pullAll(cc.page);
  row = await rowText(cc.page, id);
  assert(row.includes(`${code55.slice(0, 2)}:${code55.slice(2)}`), `${rel}: CC sees the injury time (got "${row}")`);
  assert(await cc.page.locator(`[data-injury-time-edit="${id}"]`).count() === 0 && !(await cc.page.evaluate(() => canEditInjuryTime())),
    `${rel}: CC gets no injury-time edit button (owner, 2026-11-18)`);
  assert(!SERVER.rejected.length, `${rel}: no event may be rejected (got ${JSON.stringify(SERVER.rejected)})`);

  // Stored report: the golden-hour box, and a report stored before 088 says it has none.
  const report = (gh) => ({ reports: [{ version: 1, generated_at: new Date().toISOString(), report: { incident: { visual_id: 'INC-TEST-1' }, patients: { total: 1 }, tourniquets: {},
    patient_rows: [{ visual_id: 'P001', triage: 'red', status: 'handed_over', minutes_from_open: 2, minutes_to_handover: 40 }], ...(gh ? { golden_hour: gh } : {}) } }], late_records_after_close: 0 });
  await cc.page.evaluate((r) => { _incidentReports = r; _incidentReportVersion = 1; renderIncidentReport(); }, report({ basis: 'injury_to_handover', injury_time_entered: 1, injury_time_estimated: 0, handed_over_within_60: 0, handed_over_after_60: 1,
    median_minutes_injury_to_handover: 72, red_median_minutes_injury_to_handover: 72, not_handed_over_past_60: 0, patient_rows: [{ visual_id: 'P001', triage: 'red', injury_time_source: 'entered', minutes_injury_to_handover: 72 }] }));
  const box = ((await cc.page.textContent('#aar-golden-hour')) || '').replace(/\s+/g, ' ');
  const table = ((await cc.page.textContent('.aar-table')) || '').replace(/\s+/g, ' ');
  assert(box.includes('אחרי 60 דק׳ 1') && box.includes('חציון 72 דק׳') && table.includes('מפציעה עד מסירה') && table.includes('72'),
    `${rel}: the stored report shows golden-hour figures (got "${box}" / "${table}")`);
  await cc.page.evaluate((r) => { _incidentReports = r; renderIncidentReport(); }, report(null));
  assert(((await cc.page.textContent('#aar-golden-hour')) || '').includes('לא נכלל בגרסה זו'), `${rel}: an older report says it has no golden-hour part`);

  const errors = [...m1.errors, ...m2.errors, ...pc.errors, ...cc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: injury time (WP-23) cross-device browser test passed`);
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
