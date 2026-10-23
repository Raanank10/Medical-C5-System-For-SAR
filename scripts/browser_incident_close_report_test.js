// Real-browser test of D9 (database/068, sync-log v12, V2.99.52): closing an incident ends patient
// access for everyone but admin and stores a statistics-only report.
// - The medic's phone keeps the closed incident's patients while it still has an unsent record,
//   says how many are waiting, and removes them once that record has reached the server (the
//   server accepts it after the close).
// - The stored report opens from the incident strip ("דוח סיכום"), with no names.
// - Admin keeps the local copy; a user who is neither a member nor command cannot open the report.
//
// Medic, CC, admin and logistics phones share one fake backend in this Node process (same harness
// as scripts/browser_incident_merge_test.js). The fake mirrors database/068's contract; the SQL
// itself was verified live by role impersonation (docs/RLS_AUDIT_v1.md, 068 follow-up).
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_incident_close_report_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const M1 = '11111111-1111-4111-8111-111111111111';
const CC = '33333333-3333-4333-8333-333333333333';
const ADM = '77777777-7777-4777-8777-777777777777';
const LOGO = '44444444-4444-4444-8444-444444444444';
const INC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'm1@test': { id: M1, role: 'medic', display_name: 'חובש א' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ רפואה' },
  'admin@test': { id: ADM, role: 'admin', display_name: 'מנהל' },
  'logo@test': { id: LOGO, role: 'logistics_officer', display_name: 'קל"ג' },
};
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  return {
    incident: { id: INC, visual_id: 'INC-AAAA', status: 'active', location_name: 'Synthetic Tower', address: null, incident_type: null, opened_by: M1, opened_at: new Date().toISOString(), metadata: {}, closed_at: null },
    members: [M1, ADM],
    patients: [],
    events: [],
    reports: [],
    online: true,
    rpcLog: [],
  };
}
function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const inc = server.incident;
  const member = server.members.includes(u.id);
  const canAccess = ['cc', 'chamal', 'admin'].includes(u.role) || member;
  const canReadPatients = canAccess && (u.role === 'admin' || inc.status !== 'closed');
  if (req.kind === 'sync') {
    // sync-log v12: a closed incident still accepts records (no read-back).
    (req.body.events || []).forEach((e) => {
      server.events.push({ local_event_id: e.local_event_id, type: e.type, after_close: inc.status === 'closed', patient_id: e.patient_id });
      if (e.type === 'QUICK_PATIENT_CREATED' && e.patient_id && !server.patients.some((p) => p.id === e.patient_id)) {
        server.patients.push({ id: e.patient_id, incident_id: INC, visual_id: e.payload_json?.visual_id || 'P', optional_name: e.payload_json?.name || null, current_triage: 'red', current_status: 'identified', version: 1 });
      }
    });
    const closed = inc.status === 'closed';
    return { accepted: (req.body.events || []).map((e) => ({ local_event_id: e.local_event_id, server_event_id: null, server_cursor: null, after_close: closed })), duplicates: [], rejected: [], redirected_to: null, incident_closed: closed };
  }
  if (req.kind === 'rpc') {
    const p = req.params || {};
    server.rpcLog.push({ name: req.name, by: u.role });
    if (req.name === 'list_open_incidents') {
      return { data: inc.status === 'active' && canAccess ? [{ ...clone(inc), patient_count: server.patients.length, opened_by_name: 'חובש א', is_member: member }] : [], error: null };
    }
    if (req.name === 'close_incident') {
      if (!['pc', 'cc', 'chamal', 'admin', 'physician', 'rpc', 'rcc'].includes(u.role)) return { data: null, error: { code: '42501', message: 'role' } };
      inc.status = 'closed'; inc.closed_at = new Date().toISOString();
      server.reports.push({ version: server.reports.length + 1, generated_at: inc.closed_at, report: {
        version: server.reports.length + 1,
        incident: { visual_id: inc.visual_id, location_name: inc.location_name, opened_at: inc.opened_at, closed_at: inc.closed_at, duration_minutes: 5 },
        patients: { total: server.patients.length, by_triage: { red: server.patients.length }, by_status: { identified: server.patients.length }, handed_over: 0 },
        patient_rows: server.patients.map((x) => ({ visual_id: x.visual_id, triage: x.current_triage, status: x.current_status, minutes_from_open: 1, tourniquets: 0 })),
        tourniquets: { total: 0, active_at_close: 0, over_120_minutes: 0 } } });
      return { data: { closed: true, changed: true }, error: null };
    }
    if (req.name === 'get_incident_aar_reports') {
      if (!(member || ['pc', 'rcc', 'cc', 'chamal', 'physician', 'admin'].includes(u.role))) return { data: null, error: { code: '42501', message: 'access denied to the reports' } };
      const late = server.events.filter((e) => e.after_close).length;
      return { data: { incident_id: INC, status: inc.status, closed_at: inc.closed_at, late_records_after_close: late, reports: clone(server.reports).reverse() }, error: null };
    }
    if (req.name === 'get_incident_command_state') return { data: { incident_id: INC, status: inc.status, state_json: {} }, error: null };
    if (req.name === 'join_incident') { if (!server.members.includes(u.id)) server.members.push(u.id); return { data: { id: INC }, error: null }; }
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).filter((x) => x.id === u.id).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true, company_id: null, platoon_id: null }));
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const rows = canAccess ? [clone(inc)] : [];
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'patients') {
    const rows = canReadPatients ? clone(server.patients) : [];
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  return { data: req.single ? null : [], error: null };
}

const FAKE_SUPABASE = `
(function(){
  const USERS=${JSON.stringify(USERS)};
  const session=()=>{ try{ return JSON.parse(sessionStorage.getItem('__fake_session')); }catch(e){ return null; } };
  const userId=()=>session()?.user?.id||null;
  function builder(table){
    const q={kind:'from',table,op:'select',eq:{},single:false};
    const b={};
    b.select=()=>b; b.eq=(c,v)=>{ q.eq[c]=v; return b; };
    b.single=()=>{ q.single=true; return b; }; b.maybeSingle=b.single;
    ['in','not','order','limit','update','upsert','gte','gt','lt','lte','neq','is','range','insert','delete','or'].forEach(m=>{ b[m]=()=>b; });
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
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/functions/v1/sync-log**', async (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) });
    if (!SERVER.online) return r.abort('internetdisconnected');
    const userId = (r.request().headers().authorization || '').replace('Bearer tok-', '');
    const body = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(handle(SERVER, { kind: 'sync', userId, body })) });
  });
  await page.exposeFunction('__toastSpy', (m) => toasts.push(m));
  await page.addInitScript(() => { window.addEventListener('DOMContentLoaded', () => { const orig = window.toast; window.toast = (m, ...a) => { window.__toastSpy(String(m)); return orig && orig(m, ...a); }; }); });
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  if (await page.locator('#pin-gate-setup-panel').isVisible()) {
    await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  } else {
    await page.fill('#pin-gate-unlock-input', PIN); await page.click('#pin-gate-unlock-btn');
  }
  return { page, errors, toasts };
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
  await page.evaluate(async (id) => { await refreshOpenIncidents(); await enterIncidentFromPicker(id); }, INC);
  await page.waitForFunction((id) => activeIncident?.id === id, INC, { timeout: 5000 });
}
const addPatient = (page, visualId) => page.evaluate((vid) => {
  const id = newUuid();
  patients.push({ id, visualId: vid, triage: 'red', patientStatus: 'identified', events: [], siteId: 'SITE_A', optionalName: 'Synthetic Person Zeta' });
  saveLocalEvent({ type: 'QUICK_PATIENT_CREATED', patient_id: id, payload_json: { visual_id: vid, name: 'Synthetic Person Zeta' } });
  saveDemoState();
  return id;
}, visualId);

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // Medic records a casualty; it reaches the server.
  const m1 = await openPhone(context, file);
  await login(m1.page, 'm1@test');
  await enter(m1.page);
  await addPatient(m1.page, 'P001');
  await m1.page.evaluate(() => syncPush());
  assert(SERVER.patients.length === 1, `${rel}: the first casualty must reach the server`);

  // Admin works the same incident.
  const adm = await openPhone(context, file);
  await login(adm.page, 'admin@test');
  await enter(adm.page);
  await adm.page.evaluate(() => { patients.push({ id: newUuid(), visualId: 'P009', triage: 'yellow', patientStatus: 'identified', events: [], siteId: 'SITE_A' }); saveDemoState(); });

  // The medic goes offline and records a second casualty; then CC closes the incident.
  SERVER.online = false;
  await addPatient(m1.page, 'P002');
  await m1.page.evaluate(() => syncPush());
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await cc.page.evaluate(() => toggleActiveIncidentClosed());
  await cc.page.waitForFunction(() => activeIncident?.status === 'closed', null, { timeout: 5000 });
  assert(SERVER.reports.length === 1, `${rel}: closing must store a report`);

  // Medic sees the close but still has an unsent record: nothing is removed, the strip says so.
  await m1.page.evaluate(() => refreshIncidentContext());
  await m1.page.waitForFunction(() => activeIncident?.status === 'closed', null, { timeout: 5000 });
  assert(await m1.page.evaluate(() => patients.length) === 2, `${rel}: the medic's patients must stay while a record is unsent`);
  assert((await m1.page.textContent('#incident-context-strip')).includes('ממתינות לשליחה'), `${rel}: the strip must say records are waiting`);

  // Back online: the record is accepted after the close, then the phone removes the incident.
  SERVER.online = true;
  await m1.page.evaluate(() => syncPush());
  assert(SERVER.events.some((e) => e.after_close && e.type === 'QUICK_PATIENT_CREATED'), `${rel}: the late record must be stored after the close`);
  await m1.page.evaluate(() => refreshIncidentContext());
  await m1.page.waitForFunction(() => activeIncident?.removed_from_device === true, null, { timeout: 5000 });
  const left = await m1.page.evaluate((id) => ({ patients: patients.length, outbox: getOutbox().filter((e) => e.incident_id === id).length }), INC);
  assert(left.patients === 0 && left.outbox === 0, `${rel}: the closed incident's data must be removed from the medic's phone (got ${JSON.stringify(left)})`);
  assert(m1.toasts.some((t) => t.includes('הוסרו מהמכשיר')), `${rel}: the medic must be told the data was removed`);

  // The stored report opens from the strip, without names.
  assert(await m1.page.locator('#incident-strip-report-btn').isVisible(), `${rel}: the strip must offer the report`);
  await m1.page.click('#incident-strip-report-btn');
  await m1.page.waitForSelector('#screen-incident-report.active', { timeout: 5000 });
  const reportText = await m1.page.textContent('#incident-report-body');
  assert(reportText.includes('INC-AAAA') && reportText.includes('P001'), `${rel}: the report must show the incident and temporary numbers (got ${reportText.slice(0, 200)})`);
  assert(!reportText.includes('Zeta'), `${rel}: the report must not show names`);
  assert(reportText.includes('אחרי הסגירה'), `${rel}: the report must say records arrived after the close`);

  // Admin keeps the local copy.
  await adm.page.evaluate(() => refreshIncidentContext());
  await adm.page.waitForFunction(() => activeIncident?.status === 'closed', null, { timeout: 5000 });
  assert(await adm.page.evaluate(() => patients.length) >= 1 && !(await adm.page.evaluate(() => activeIncident.removed_from_device)), `${rel}: admin must keep the closed incident's data`);

  // Logistics (not a member, not command) cannot open the report.
  const logo = await openPhone(context, file);
  await login(logo.page, 'logo@test');
  await logo.page.evaluate((id) => openIncidentReport(id), INC);
  await logo.page.waitForTimeout(300);
  assert(logo.toasts.some((t) => t.includes('טעינת דוח הסיכום נכשלה')), `${rel}: a non-member must not get the report`);

  const errors = [...m1.errors, ...adm.errors, ...cc.errors, ...logo.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: incident close + stored report (D9) browser test passed`);
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
