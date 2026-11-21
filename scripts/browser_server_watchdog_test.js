// Real-browser test of the server watchdog's alerts on phones (WP-12, V2.99.58). The minute job
// (database/072 app.run_clinical_watchdog) writes watchdog_alerts; a CC phone and a medic phone
// (two browser contexts) read the open ones from one fake backend in this Node process (harness of
// scripts/browser_remote_vitals_test.js). A server alert is listed only when the phone does not
// already raise the same thing from its own data, marked "(שרת)", for command and the medic. It
// proves client behavior only; the live read policy (app.can_read_incident_patients) decides who
// sees what, and the job itself was verified live (rolled back) when 072 was applied.
// WP-29 (database/095, step 9): the server's Dead Man's Switch for a silent medic, listed for PC
// and CC (not the medic), in the RCC / RPC strip, hidden once this phone sees a newer heartbeat
// from that medic, gone when resolved. The fake read policy mirrors 095: the rescue chain reads
// DEAD_MAN_SWITCH rows only.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_server_watchdog_test.js
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
const UNKNOWN = '77777777-7777-4777-8777-777777777777';
const PC = '22222222-2222-4222-8222-222222222222';
const RCC = '44444444-4444-4444-8444-444444444444';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש ראשון' },
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'rcc@test': { id: RCC, role: 'rcc', display_name: 'מ"פ חילוץ בדיקה' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const ALLOWED = { medic: ['VITALS_RECORDED', 'PATIENT_TRIAGE_UPDATED', 'PATIENT_STATUS_UPDATED', 'WATCHDOG_ACKNOWLEDGED'], cc: ['WATCHDOG_ACKNOWLEDGED'] };

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [MEDIC, PC].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    events: [],
    rejected: [],
    alerts: [],
    alertReads: [],
    tourniquets: [],
    presence: [],
  };
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    server.events.push({ ...e, id: `ev-${server.events.length + 1}`, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId, actor_role: u.role });
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
  if (req.table === 'tourniquets') {
    const rows = server.tourniquets.filter((t) => server.incidents.some((i) => i.id === t.incident_id && canSee(i))).filter(match);
    return { data: clone(rows), error: null };
  }
  if (req.table === 'watchdog_alerts') {
    server.alertReads.push(clone(req));
    // read policy: the incident's members and blanket command roles; only open alerts are asked for.
    const rows = server.alerts.filter((a) => a.resolved_at == null && server.incidents.some((i) => i.id === a.incident_id && canSee(i)))
      // database/074 + 095: the rescue chain reads the Dead Man's Switch only
      .filter((a) => !['rpc', 'rcc'].includes(u.role) || a.alert_type === 'DEAD_MAN_SWITCH')
      .filter(match);
    return { data: clone(req.limit ? rows.slice(0, req.limit) : rows), error: null };
  }
  if (req.table === 'device_presence') {
    if (req.op === 'upsert') return { data: null, error: null };
    return { data: clone(server.presence.filter((d) => server.incidents.some((i) => i.id === d.incident_id && canSee(i))).filter(match)), error: null };
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
    b.select=(c)=>{ q.select=c; return b; }; b.eq=(c,v)=>{ q.eq[c]=v; return b; }; b.in=(c,v)=>{ q.in[c]=v; return b; }; b.is=(c,v)=>{ q.is=q.is||{}; q.is[c]=v; return b; };
    b.not=(c,op,v)=>{ if(op==='is'&&v===null) q.notNull.push(c); return b; };
    b.order=(c,o)=>{ q.order={c,asc:o?.ascending!==false}; return b; }; b.limit=n=>{ q.limit=n; return b; };
    b.single=()=>{ q.single=true; return b; }; b.maybeSingle=b.single;
    b.update=p=>{ q.op='update'; q.payload=p; return b; };
    b.upsert=(p,o)=>{ q.op='upsert'; q.payload=p; q.ignoreDup=!!o?.ignoreDuplicates; return b; };
    ['gte','gt','lt','lte','neq','range','insert','delete'].forEach(m=>{ b[m]=b[m]||(()=>b); });
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

const min = (n) => new Date(Date.now() - n * 60000).toISOString();
const alert = (id, patient, type, severity, payload, extra = {}) => ({ id, incident_id: INC1, patient_id: patient, alert_type: type, severity, triggered_at: min(1), resolved_at: null, payload_json: { source: 'server_watchdog', ...payload }, ...extra });
// P-VT: fresh vitals here, no tourniquet known here. P-OTHER: green here with vitals 25 min ago,
// and a tourniquet read from the server's tourniquets table, applied 70 minutes ago (so this phone
// is already at "warning" for it).
const addPatients = (page) => page.evaluate(([a, b]) => {
  const now = Date.now();
  patients.push({ id: a, visualId: 'P-VT', triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], txHistory: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], lastVitalsAt: now - 60000, time: '10:00', sourcedFromRemote: true });
  patients.push({ id: b, visualId: 'P-OTHER', triage: 'green', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], txHistory: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], lastVitalsAt: now - 25 * 60000, time: '10:00', sourcedFromRemote: true });
}, [PATIENT, OTHER]);
const pullAlerts = async (page) => {
  await page.evaluate(() => Promise.all(Object.values(SITE_TO_INCIDENT_ID).map((id) => pullServerWatchdogAlerts(id))));
  await page.waitForTimeout(200);
};
const listed = (page, audience) => page.evaluate((aud) => buildAlertObjects(patients).filter((a) => a.audience.includes(aud) && a.source === 'server').map((a) => ({ id: a.id, type: a.type, patientId: a.patientId, title: a.title, detail: a.detail, severity: a.severity, category: a.category })), audience);

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

  const cc = await phone();
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await addPatients(cc.page);
  const m = await phone();
  await login(m.page, 'medic@test');
  await enter(m.page);
  await addPatients(m.page);

  // 0. Nothing is listed while the server has no open watchdog alert.
  assert((await listed(cc.page, 'cc')).length === 0, `${rel}: no server alert before the watchdog raised any`);

  SERVER.tourniquets.push({ id: 'tq-other', incident_id: INC1, patient_id: OTHER, limb: 'left_leg', applied_at: min(70), is_active: true, tourniquet_status: 'applied' });
  await cc.page.evaluate(() => pullProjectedPatientStateAll());
  await cc.page.waitForTimeout(500);
  // The minute job raises these (and has already resolved one).
  SERVER.alerts.push(
    // duplicate of this phone's own data: vitals recorded here after the server's baseline
    alert('a-vt-vitals', PATIENT, 'VITALS_OVERDUE', 'critical', { baseline_at: min(30), minutes: 30 }),
    // not known here: the tourniquet on P-VT; the limb text is never rendered as markup
    alert('a-vt-tq', PATIENT, 'TOURNIQUET_TIME_CRITICAL', 'critical', { limb: '<img src=x onerror=window.__xss=1>', minutes: 125, level: 'critical' }),
    // the server's baseline is newer than this phone's vitals and this phone is not overdue (green): listed
    alert('a-other-vitals', OTHER, 'VITALS_OVERDUE', 'warning', { baseline_at: min(22), minutes: 22 }),
    // this phone's own timer is already at warning: not listed again
    alert('a-other-tq', OTHER, 'TOURNIQUET_TIME_WARNING', 'warning', { limb: 'left_leg', minutes: 70, level: 'warning' }),
    // ignored: resolved, not from the watchdog, a patient this phone does not have
    alert('a-resolved', PATIENT, 'TOURNIQUET_TIME_NOTICE', 'info', { minutes: 46 }, { resolved_at: min(0) }),
    { ...alert('a-legacy', PATIENT, 'PEDIATRIC_MEDICATION_MISSING_WEIGHT', 'critical', {}), payload_json: {} },
    alert('a-unknown', UNKNOWN, 'TOURNIQUET_TIME_CRITICAL', 'critical', { minutes: 130 }),
  );

  // 1. The regular pull reads the open watchdog alerts (open only, watchdog types only).
  await cc.page.evaluate(() => pullProjectedPatientStateAll());
  await cc.page.waitForTimeout(500);
  // The per-incident pull (eq); since V2.99.68 the CC's all-incidents view also reads every open incident's alerts (in).
  const read = SERVER.alertReads.find((r) => r.userId === CC && r.eq.incident_id);
  assert(read && read.eq.incident_id === INC1 && read.is && read.is.resolved_at === null && JSON.stringify(read.in.alert_type) === JSON.stringify(['TOURNIQUET_TIME_NOTICE', 'TOURNIQUET_TIME_WARNING', 'TOURNIQUET_TIME_DECISION', 'TOURNIQUET_TIME_CRITICAL', 'VITALS_OVERDUE', 'DEAD_MAN_SWITCH']),
    `${rel}: the pull must ask for this incident's open watchdog alerts (got ${JSON.stringify(read)})`);

  // 2. CC: only what this phone does not raise itself, marked as from the server.
  let l = await listed(cc.page, 'cc');
  const ids = l.map((a) => a.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(['server-tq-a-vt-tq', 'server-vitals-a-other-vitals']), `${rel}: CC must list the unknown tourniquet and the newer vitals baseline only (got ${JSON.stringify(l)})`);
  const tq = l.find((a) => a.id === 'server-tq-a-vt-tq');
  assert(tq.title.includes('P-VT') && tq.title.includes('קריטי') && tq.title.includes('(שרת)') && tq.severity === 'critical' && tq.category === 'urgent' && tq.detail.includes('125'), `${rel}: tourniquet alert text (got ${JSON.stringify(tq)})`);
  const vt = l.find((a) => a.id === 'server-vitals-a-other-vitals');
  assert(vt.title.includes('P-OTHER') && vt.title.includes('מדדים באיחור (שרת)') && vt.severity === 'high', `${rel}: vitals alert text (got ${JSON.stringify(vt)})`);
  const local = await cc.page.evaluate(() => buildAlertObjects(patients).filter((a) => a.source !== 'server' && a.type === 'TOURNIQUET_WARNING').map((a) => a.patientId));
  assert(local.includes(OTHER), `${rel}: P-OTHER's warning stays this phone's own alert`);

  // 3. Shown on the command screen, no markup from the payload.
  await cc.page.evaluate(() => { if (typeof renderCmdContent === 'function') renderCmdContent(); });
  await cc.page.evaluate(() => { const d = document.createElement('div'); d.id = '__probe'; d.innerHTML = buildAlertObjects(patients).filter((a) => a.source === 'server').map((a) => renderAlertCard(a)).join(''); document.body.appendChild(d); });
  const probe = await cc.page.textContent('#__probe');
  assert(probe.includes('(שרת)') && !(await cc.page.evaluate(() => window.__xss)) && !(await cc.page.evaluate(() => !!document.querySelector('#__probe img'))), `${rel}: rendered without markup from the payload`);

  // 4. The medic sees them too, in the alert list on the phone.
  await m.page.evaluate(() => pullProjectedPatientStateAll());
  await m.page.waitForTimeout(500);
  l = await listed(m.page, 'medic');
  assert(l.length === 2, `${rel}: the medic must see the same two (got ${JSON.stringify(l)})`);
  await m.page.evaluate(() => { alertFilter = 'all'; renderAlerts(); });
  const banner = await m.page.textContent('#alerts-banner');
  assert(banner.includes('חסם עורקים קריטי (שרת)'), `${rel}: the medic's alert list must show the tourniquet alert (got ${banner.slice(0, 300)})`);
  // Vitals alerts (category "data", like this phone's own red/yellow vitals alerts) are in the
  // medic dashboard's alert rows rather than the urgent list.
  const rows = await m.page.evaluate(() => roleAlertRows('medic').map((a) => a.title));
  assert(rows.some((t) => t.includes('מדדים באיחור (שרת)')) && rows.some((t) => t.includes('חסם עורקים קריטי (שרת)')), `${rel}: the medic dashboard rows must include both (got ${JSON.stringify(rows)})`);

  // 5. Once this phone has the data itself, the server copy goes away: vitals recorded here after
  //    the server's baseline, and the tourniquet known here at its level.
  SERVER.tourniquets.push({ id: 'tq-vt', incident_id: INC1, patient_id: PATIENT, limb: 'right_arm', applied_at: min(125), is_active: true, tourniquet_status: 'applied' });
  await cc.page.evaluate(() => pullProjectedPatientStateAll());
  await cc.page.waitForTimeout(500);
  await cc.page.evaluate((b) => { patients.find((p) => p.id === b).lastVitalsAt = Date.now(); }, OTHER);
  assert((await listed(cc.page, 'cc')).length === 0, `${rel}: no server copy once this phone raises the same alerts itself`);

  // 6. The server resolves an alert: gone after the next read.
  await m.page.evaluate((b) => { patients.find((p) => p.id === b).lastVitalsAt = Date.now() - 25 * 60000; }, OTHER);
  SERVER.alerts.find((a) => a.id === 'a-vt-tq').resolved_at = min(0);
  await pullAlerts(m.page);
  l = await listed(m.page, 'medic');
  assert(l.length === 1 && l[0].id === 'server-vitals-a-other-vitals', `${rel}: a resolved server alert must disappear (got ${JSON.stringify(l)})`);

  // 7. Logistics and rescue roles are not an audience.
  const aud = await m.page.evaluate(() => buildAlertObjects(patients).filter((a) => a.source === 'server').map((a) => a.audience));
  assert(aud.every((a) => !a.includes('logistics') && !a.includes('rpc')), `${rel}: command and medic only (got ${JSON.stringify(aud)})`);

  // 8. The 100-minute level (database/079): listed while this phone's own timer is below it
  //    (P-OTHER's tourniquet is at 70 minutes here).
  SERVER.alerts.push(alert('a-other-decision', OTHER, 'TOURNIQUET_TIME_DECISION', 'warning', { limb: 'left_leg', minutes: 101, level: 'decision' }));
  await pullAlerts(cc.page);
  l = await listed(cc.page, 'cc');
  const dec = l.find((a) => a.id === 'server-tq-a-other-decision');
  assert(dec && dec.title.includes('P-OTHER') && dec.title.includes('100 דקות') && dec.title.includes('(שרת)') && dec.severity === 'high', `${rel}: the server's 100-minute alert must be listed (got ${JSON.stringify(l)})`);

  // 9. WP-29: the server's Dead Man's Switch (database/095). The medic has been silent 12 minutes.
  const dmsName = '<img src=x onerror=window.__xss=2>חובש ראשון';
  const dms = (id, extra = {}) => ({ id, incident_id: INC1, patient_id: null, actor_id: MEDIC, alert_type: 'DEAD_MAN_SWITCH', severity: 'critical', triggered_at: min(2), resolved_at: null,
    payload_json: { source: 'server_watchdog', medic_name: dmsName, role: 'medic', open_patients: 2, last_contact_at: min(12), last_heartbeat_at: min(14), last_event_at: min(12), minutes: 10 }, ...extra });
  SERVER.alerts.push(dms('a-dms'), { ...dms('a-dms-legacy'), payload_json: { medic: 'Medic Levi' } });
  SERVER.presence.push({ incident_id: INC1, actor_id: MEDIC, device_id: 'dev-medic', last_heartbeat_at: min(14), sync_status: 'online', current_patient_id: null });
  await cc.page.evaluate(() => Promise.all([pullDevicePresenceAll(), ...Object.values(SITE_TO_INCIDENT_ID).map((id) => pullServerWatchdogAlerts(id))]));
  await cc.page.waitForTimeout(300);
  l = (await listed(cc.page, 'cc')).filter((a) => a.type === 'SERVER_DEAD_MAN_SWITCH');
  assert(l.length === 1 && l[0].id === 'server-dms-a-dms' && l[0].severity === 'critical' && !l[0].patientId, `${rel}: CC must list one Dead Man's Switch, no patient, the legacy row ignored (got ${JSON.stringify(l)})`);
  assert(l[0].title.includes('אין קשר 12 דק׳ (שרת)') && l[0].title.includes('חובש') && l[0].detail.includes('2 פצועים') && l[0].detail.includes('לפי השרת'), `${rel}: DMS text counts from the last contact (got ${JSON.stringify(l[0])})`);
  const p = await phone();
  await login(p.page, 'pc@test');
  await enter(p.page);
  await pullAlerts(p.page);
  assert((await listed(p.page, 'pc')).some((a) => a.id === 'server-dms-a-dms'), `${rel}: the PC must list the Dead Man's Switch`);
  await pullAlerts(m.page);
  assert(!(await listed(m.page, 'medic')).some((a) => a.type === 'SERVER_DEAD_MAN_SWITCH'), `${rel}: the medic is not an audience of the Dead Man's Switch`);
  // rendered on the command screen without markup from the payload
  await p.page.evaluate(() => { const d = document.createElement('div'); d.id = '__dms'; d.innerHTML = commandAlertGroups(buildAlertObjects(patients).filter((a) => a.type === 'SERVER_DEAD_MAN_SWITCH')).map(commandAlertLineHtml).join(''); document.body.appendChild(d); });
  const dmsText = await p.page.textContent('#__dms');
  assert(dmsText.includes('אין קשר') && !(await p.page.evaluate(() => window.__xss)) && !(await p.page.evaluate(() => !!document.querySelector('#__dms img'))), `${rel}: DMS line rendered as text (got ${dmsText})`);
  // CC all-incidents view (WP-33): the incident line counts it
  const ov = await cc.page.evaluate(async (inc) => { await refreshOpenIncidents(); await pullAllIncidentAlertData(getSupabaseClient(), [inc], []); return ccOverviewAlertGroups().flatMap((g) => g.alerts.map((a) => a.type)); }, INC1);
  assert(ov.includes('SERVER_DEAD_MAN_SWITCH'), `${rel}: the CC all-incidents view must include the Dead Man's Switch (got ${JSON.stringify(ov)})`);

  // RCC: reads the Dead Man's Switch only, shown in its strip
  const r = await phone();
  await login(r.page, 'rcc@test');
  await r.page.evaluate(() => refreshOpenIncidents());
  await r.page.waitForTimeout(300);
  const rccRead = SERVER.alertReads.filter((q) => q.userId === RCC);
  assert(rccRead.length && rccRead.every((q) => q.eq.alert_type === 'DEAD_MAN_SWITCH' || (q.in.alert_type || []).includes('DEAD_MAN_SWITCH')), `${rel}: the RCC reads watchdog alerts for the Dead Man's Switch (got ${JSON.stringify(rccRead)})`);
  await r.page.evaluate(() => { const d = document.createElement('div'); d.id = '__rcc'; d.innerHTML = renderRccPanel(); document.body.appendChild(d); });
  const rccLine = await r.page.textContent('#__rcc [data-rcc-dms="a-dms"]').catch(() => null);
  assert(rccLine && rccLine.includes('אין קשר') && rccLine.includes('2 פצועים') && !(await r.page.evaluate(() => !!document.querySelector('#__rcc img'))) && !(await r.page.evaluate(() => window.__xss)), `${rel}: the RCC strip shows the Dead Man's Switch as text (got ${rccLine})`);
  assert(!(await r.page.evaluate(() => !!document.querySelector('#__rcc [data-rcc-dms="a-dms-legacy"]'))), `${rel}: a row not from the server watchdog is not shown to the RCC`);

  // A heartbeat newer than the contact the alert was raised on: hidden here before the server resolves it
  SERVER.presence[0].last_heartbeat_at = min(0);
  await cc.page.evaluate(() => pullDevicePresenceAll());
  await cc.page.waitForTimeout(300);
  assert(!(await listed(cc.page, 'cc')).some((a) => a.type === 'SERVER_DEAD_MAN_SWITCH'), `${rel}: a newer heartbeat seen here hides the Dead Man's Switch`);
  // resolved by the server: gone for the PC and the RCC
  SERVER.alerts.find((a) => a.id === 'a-dms').resolved_at = min(0);
  await pullAlerts(p.page);
  assert(!(await listed(p.page, 'pc')).some((a) => a.type === 'SERVER_DEAD_MAN_SWITCH'), `${rel}: a resolved Dead Man's Switch disappears for the PC`);
  await r.page.evaluate(() => refreshOpenIncidents());
  await r.page.waitForTimeout(300);
  assert(!(await r.page.evaluate(() => renderRccPanel().includes('data-rcc-dms='))), `${rel}: a resolved Dead Man's Switch disappears from the RCC strip`);

  const errors = [...m.errors, ...cc.errors, ...p.errors, ...r.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: server watchdog alerts browser test passed`);
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
