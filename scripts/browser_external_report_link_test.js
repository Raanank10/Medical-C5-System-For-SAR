// Real-browser test of linking an external report to a patient later (WP-16 PR B, database/069,
// V2.99.53): a PC, a CC and a medic phone share one fake backend (the harness of
// scripts/browser_evacuation_tracking_test.js). The fake mirrors the server:
// - role gating as in supabase/functions/sync-log/index.ts (EXTERNAL_REPORT_* and
//   PATIENT_EVACUATION_UPDATED: pc/cc/chamal/physician/admin);
// - projection as in database/044 + 069: a report row per EXTERNAL_REPORT_CREATED; a link per
//   EXTERNAL_REPORT_LINKED found by external_report_id or external_reference, removed by
//   action 'unlink'; external_patient_links embedded in the external_reports read.
// It proves client behavior only; database/069 itself was verified against the live Postgres.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_external_report_link_test.js
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
  pc: [...CLINICAL, 'EXTERNAL_REPORT_CREATED', 'EXTERNAL_REPORT_LINKED', 'PATIENT_EVACUATION_UPDATED'],
  cc: ['EXTERNAL_REPORT_CREATED', 'EXTERNAL_REPORT_LINKED', 'PATIENT_EVACUATION_UPDATED'],
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
    links: [],
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
    if (e.type === 'EXTERNAL_REPORT_LINKED' && p) {
      const rpt = server.external_reports.find((r) => r.incident_id === body.incident_id && (r.id === pj.external_report_id || (pj.external_reference && r.external_reference === pj.external_reference)));
      if (rpt) {
        server.links = server.links.filter((l) => !(l.external_report_id === rpt.id && l.patient_id === p.id));
        if (pj.action !== 'unlink') server.links.push({ external_report_id: rpt.id, patient_id: p.id });
      }
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
    let rows = server[req.table].filter((r) => server.incidents.some((i) => i.id === r.incident_id && canSee(i))).filter(match);
    if (req.table === 'external_reports') rows = rows.map((r) => ({ ...r, external_patient_links: server.links.filter((l) => l.external_report_id === r.id).map((l) => ({ patient_id: l.patient_id })) }));
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

async function linkedChips(page) {
  return (await page.evaluate(() => [...document.querySelectorAll('#cmd-ext-reports .ext-report-card .identity-chip')].map((x) => x.textContent.trim())));
}
async function openCommander(page) {
  await page.evaluate(() => goTo('commander'));
  await page.waitForTimeout(250);
}

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // PC phone: two casualties, then an MDA report entered on its own (no patient named).
  const pc = await openPhone(context, file);
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  const [idA, idB] = await pc.page.evaluate(() => {
    siteData.currentZone = 'קומה 1'; createImmediateInterventionPatient('airway'); const a = patients[0].id;
    siteData.currentZone = 'קומה 2'; createImmediateInterventionPatient('airway'); const b = patients[0].id;
    return [a, b];
  });
  await syncAll(pc.page);
  await syncAll(pc.page);
  const visB = await pc.page.evaluate((id) => patients.find((p) => p.id === id).visualId, idB);
  const visA = await pc.page.evaluate((id) => patients.find((p) => p.id === id).visualId, idA);
  await pc.page.evaluate(() => { prepareExternalReport(); goTo('add-report'); });
  await pc.page.click(`#report-source-grid button[onclick*="'MDA'"]`);
  await pc.page.evaluate(() => { changeRC('red', 1); changeRC('yellow', 1); });
  await pc.page.click('#btn-save-report');
  await syncAll(pc.page);
  const rpt = SERVER.external_reports[0];
  assert(rpt && rpt.source === 'mda' && rpt.reported_red === 1, `${rel}: MDA report must reach the server`);
  assert(SERVER.links.length === 0, `${rel}: a report entered on its own names no patient`);

  // PC links it to patient A from the report card on the command screen, before sync: chip shows pending.
  await openCommander(pc.page);
  await pc.page.click('#cmd-ext-reports .ext-report-card button:has-text("שייך לפצוע")');
  await pc.page.waitForSelector('#report-link-modal:not(.hidden)');
  assert(await pc.page.locator('#report-link-confirm').isDisabled(), `${rel}: confirm stays disabled until a patient is chosen`);
  await pc.page.click(`#report-link-patients button[data-link-patient="${idA}"]`);
  await pc.page.click('#report-link-confirm');
  await openCommander(pc.page);
  let chips = await linkedChips(pc.page);
  assert(chips.some((c) => c.includes(visA) && c.includes('ממתין לשליחה')), `${rel}: an unsent link shows as pending (got ${JSON.stringify(chips)})`);
  const ev = await pc.page.evaluate(() => getOutbox().filter((e) => e.type === 'EXTERNAL_REPORT_LINKED'));
  assert(ev.length === 1 && ev[0].patient_id === idA && ev[0].payload_json.external_reference === rpt.external_reference, `${rel}: the link is sent patient-scoped with the report's reference (got ${JSON.stringify(ev)})`);
  await syncAll(pc.page);
  assert(SERVER.links.length === 1 && SERVER.links[0].patient_id === idA, `${rel}: the server must hold the link to A`);
  assert(SERVER.patients.find((p) => p.id === idA).current_triage === 'red', `${rel}: a link never changes triage`);
  await pc.page.evaluate(() => pullExternalReports(activeIncident.id));
  await pc.page.waitForTimeout(200);
  await openCommander(pc.page);
  chips = await linkedChips(pc.page);
  assert(chips.some((c) => c.includes(visA) && !c.includes('ממתין')), `${rel}: once the server has it, the link is no longer pending (got ${JSON.stringify(chips)})`);
  assert(await pc.page.evaluate(() => Object.keys(siteData.externalReportLinks || {}).length) === 0, `${rel}: the phone's overlay is cleared once the server matches`);

  // CC (another phone) sees the link, links B with MDA's classification, unlinks A.
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await pullAll(cc.page);
  await cc.page.evaluate(() => pullExternalReports(activeIncident.id));
  await cc.page.waitForTimeout(200);
  await openCommander(cc.page);
  chips = await linkedChips(cc.page);
  assert(chips.some((c) => c.includes(visA)), `${rel}: CC must see the PC's link (got ${JSON.stringify(chips)})`);
  await cc.page.click('#cmd-ext-reports .ext-report-card button:has-text("שייך לפצוע")');
  await cc.page.waitForSelector('#report-link-modal:not(.hidden)');
  assert(await cc.page.locator(`#report-link-patients button[data-link-patient="${idA}"]`).isDisabled(), `${rel}: an already linked patient cannot be linked twice`);
  await cc.page.click(`#report-link-patients button[data-link-patient="${idB}"]`);
  await cc.page.click('#report-link-mda button[data-mda="moderate"]');
  await cc.page.click('#report-link-confirm');
  await cc.page.click('#cmd-ext-reports .ext-report-card button:has-text("שייך לפצוע")');
  await cc.page.waitForSelector('#report-link-modal:not(.hidden)');
  await cc.page.click(`#report-link-patients button[data-unlink-patient="${idA}"]`);
  await cc.page.evaluate(() => closeReportLinkSheet());
  await syncAll(cc.page);
  const ccLinks = SERVER.events.filter((e) => e.type === 'EXTERNAL_REPORT_LINKED' && e.actor_id === CC);
  assert(ccLinks.length === 2 && ccLinks.every((e) => e.payload_json.external_report_id === rpt.id), `${rel}: a report read from the server is named by its server id (got ${JSON.stringify(ccLinks.map((e) => e.payload_json))})`);
  assert(ccLinks.some((e) => e.payload_json.action === 'unlink' && e.patient_id === idA), `${rel}: the unlink is sent`);
  assert(SERVER.links.length === 1 && SERVER.links[0].patient_id === idB, `${rel}: server holds only B after CC's link and unlink (got ${JSON.stringify(SERVER.links)})`);
  const pB = SERVER.patients.find((p) => p.id === idB);
  assert(pB.mda_classification === 'moderate' && pB.current_triage === 'red', `${rel}: MDA classification is recorded beside triage, triage unchanged`);
  assert(!SERVER.rejected.length, `${rel}: no event may be rejected (got ${JSON.stringify(SERVER.rejected)})`);

  // The PC phone follows.
  await pc.page.evaluate(() => pullExternalReports(activeIncident.id));
  await pc.page.waitForTimeout(200);
  await openCommander(pc.page);
  chips = await linkedChips(pc.page);
  assert(chips.some((c) => c.includes(visB)) && !chips.some((c) => c.includes(visA)), `${rel}: PC must show B linked and A unlinked (got ${JSON.stringify(chips)})`);

  // A medic is not offered linking, and a direct call sends nothing.
  const medic = await openPhone(context, file);
  await login(medic.page, 'medic@test');
  await enter(medic.page);
  assert(!(await medic.page.evaluate(() => canUpdateEvacuationTracking())), `${rel}: a medic must not be offered linking`);
  await medic.page.evaluate(() => openReportLinkSheet('x', 'SITE_A'));
  assert(await medic.page.locator('#report-link-modal:not(.hidden)').count() === 0, `${rel}: the link sheet does not open for a medic`);

  const errors = [...pc.errors, ...cc.errors, ...medic.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: external report linking cross-device browser test passed`);
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
