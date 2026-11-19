// Real-browser test of the RCC panel (V2.99.76, owner 2026-11-19).
// Local demo mode, then a signed-in RCC against a fake backend in this Node process (the harness of
// scripts/browser_role_clinical_scope_test.js). Checks:
// - the RCC opens on a table of every incident (one row each) with urgent / trapped / on site /
//   being evacuated / evacuated counts, never a triage colour; responsibilities only behind a button
// - a row opens that incident: its patients in the shared evacuation order, incident type, building
//   status (shown when a building is involved, otherwise behind a button), site clear and close;
//   close still goes through the close guard while patients are not handed over
// - a message (banner + feed line) when a patient reaches the evacuation point (נאפ״ל) or is
//   evacuated to hospital; nothing for what was already so on the first look
// - signed in: the table comes from get_rescue_patient_board() per incident and
//   incident_site_authority, never the patients table; evac_point_arrived_at (database/085) tells
//   "arrived" from "on the way", and a server without it gives "בפינוי לנאפ״ל"
// It proves client behavior only; database/085 itself is exercised against real Postgres.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_rcc_panel_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const INC2 = '22222222-aaaa-4aaa-8aaa-222222222222';
const RCC = '33333333-3333-4333-8333-333333333333';
const pid = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const TRIAGE_WORDS = ['אדום', 'צהוב', 'ירוק', 'שחור', 'חסם'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const RPC = '44444444-4444-4444-8444-444444444444';
const PLT1 = '55555555-5555-4555-8555-555555555555';
const PLT2 = '66666666-6666-4666-8666-666666666666';
const USERS = {
  'rcc@test': { id: RCC, role: 'rcc', display_name: 'מ"פ חילוץ בדיקה', platoon_id: null },
  'rpc@test': { id: RPC, role: 'rpc', display_name: 'מ"מ חילוץ בדיקה', platoon_id: PLT1 },
};
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const b = (id, inc, visual, priority, evac, order, extra = {}) => ({ id, incident_id: inc, visual_id: visual, optional_name: null,
    identifying_description: `תיאור ${visual}`, location_json: { zone: 'קומה 1', label: 'קומה 1' }, access_status: 'free', trap_status: 'not_trapped',
    is_trapped: false, evac_state: evac, priority, evac_order: order, updated_at: new Date().toISOString(), version: 1, evac_point_arrived_at: null, was_trapped: false, ...extra });
  return {
    incidents: [
      { id: INC1, visual_id: 'INC-1', status: 'active', location_name: 'רחוב הרצל', address: null, incident_type: 'missile_strike_structural_collapse', t_zero: null, opened_at: new Date().toISOString(), patient_count: 3, is_member: false, platoon_id: PLT1 },
      { id: INC2, visual_id: 'INC-2', status: 'active', location_name: 'צומת גומא', address: null, incident_type: 'vehicle_accident', t_zero: null, opened_at: new Date().toISOString(), patient_count: 2, is_member: false, platoon_id: PLT2 },
    ],
    boards: {
      [INC1]: [
        b(pid(1), INC1, 'P001-AA', 'urgent', 'on_site', 1, { access_status: 'trapped', trap_status: 'trapped', is_trapped: true, was_trapped: true }),
        b(pid(2), INC1, 'P002-AA', 'not_urgent', 'evacuating', 2),
        b(pid(3), INC1, 'P003-AA', 'urgent', 'evacuated', 3, { was_trapped: true }),
      ],
      [INC2]: [
        b(pid(4), INC2, 'P001-BB', 'urgent', 'on_site', 1),
        b(pid(5), INC2, 'P002-BB', 'pending', 'on_site', 2),
      ],
    },
    authority: [{ incident_id: INC1, official_t0: new Date(Date.now() - 30 * 60000).toISOString(), building_status: 'unstable', site_cleared_at: null }],
    clinicalReads: 0,
  };
}

function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') return { data: clone(server.incidents), error: null };
    if (req.name === 'get_rescue_patient_board') return { data: clone(server.boards[p.p_incident_id] || []), error: null };
    if (req.name === 'get_incident_command_state') return { data: null, error: { message: 'access denied' } };
    return { data: null, error: null };
  }
  if (['patients', 'tourniquets', 'watchdog_alerts', 'vw_patient_treatment_history'].includes(req.table)) { server.clinicalReads += 1; return { data: [], error: null }; }
  if (req.table === 'incident_site_authority') {
    const ids = req.in.incident_id || (req.eq.incident_id ? [req.eq.incident_id] : []);
    const rows = server.authority.filter((r) => ids.includes(r.incident_id));
    return { data: clone(req.single ? (rows[0] || null) : rows), error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).filter((x) => !req.eq.id || x.id === req.eq.id)
      .map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true, company_id: null, platoon_id: x.platoon_id }));
    return { data: req.single ? rows[0] : rows, error: null };
  }
  if (req.table === 'incidents') {
    const rows = server.incidents.filter((i) => Object.entries(req.eq || {}).every(([c, v]) => i[c] === v)
      && Object.entries(req.in || {}).every(([c, v]) => v.includes(i[c])));
    return { data: clone(req.single ? (rows[0] || null) : rows), error: null };
  }
  return { data: req.single ? null : [], error: null };
}

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
    const body = r.request().postDataJSON() || {};
    const accepted = (body.events || []).map((e) => ({ local_event_id: e.local_event_id }));
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted, duplicates: [], rejected: [], blocked_dependency: [], high_risk_flags: [], field_conflicts: [] }) });
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
async function pullAll(page) {
  for (let i = 0; i < 2; i++) { await page.evaluate(() => pullProjectedPatientStateAll()); await page.waitForTimeout(350); }
}
let SERVER = null;

const bodyText = (page) => page.evaluate(() => document.getElementById('role-dashboard-body')?.innerText || '');
const noTriage = (text, where) => TRIAGE_WORDS.forEach((w) => assert(!text.includes(w), `${where}: the RCC must not see "${w}" (got ${text.slice(0, 400)})`));

async function checkDemo(browser, rel, file) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const base = { events: [], location: 'בניין 3', patientStatus: 'in_treatment', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', trapStatus: 'not_trapped', vitals: {}, createdAt: new Date(Date.now() - 20 * 60000).toISOString() };
    patients.push({ ...base, id: 'r1', visualId: 'P001', fullName: 'ישראל ישראלי', triage: 'red', tourniquets: [{ id: 'T1', limb: 'rl', appliedAt: Date.now() - 50 * 60000, status: 'active' }] });
    patients.push({ ...base, id: 'r2', visualId: 'P002', triage: 'red', trapStatus: 'trapped' });
    patients.push({ ...base, id: 'y1', visualId: 'P003', triage: 'yellow', patientStatus: 'evacuating' });
    patients.push({ ...base, id: 'b1', visualId: 'P005', triage: 'green', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B' });
    patients.push({ ...base, id: 'b2', visualId: 'P006', triage: 'green', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', trapStatus: 'trapped' });
    patients.push({ ...base, id: 'b3', visualId: 'P007', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', trapStatus: 'trapped' });
    patients.push({ ...base, id: 'b4', visualId: 'P008', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', trapStatus: 'access_blocked', accessibility: 'blocked' });
    ensureSiteStatusFields('SITE_A').incidentType = 'missile_strike_structural_collapse';
    ensureSiteStatusFields('SITE_B').incidentType = 'mass_shooting';
    goTo('demo'); startRoleDashboard('rcc');
  });
  // 1. Overview: one row per incident, counts by priority / stage, no colour, responsibilities hidden.
  const ov = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-rcc-incident-row]')].map((tr) => ({ key: tr.dataset.rccIncidentRow, cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()) })),
    resp: !!document.querySelector('[data-rcc-responsibilities-panel]'),
    stripHidden: getComputedStyle(document.querySelector('#screen-role-dashboard .demo-strip')).display === 'none',
  }));
  assert(JSON.stringify(ov.rows.map((r) => r.key)) === '["SITE_A","SITE_B"]', `${rel}: one table row per incident (got ${JSON.stringify(ov.rows)})`);
  // columns (owner 2026-11-19): trapped urgent, trapped not urgent, trapped not sorted, trapped in
  // total (still to be extracted), at the נאפ״ל, evacuated to hospital, every casualty of the incident
  assert(JSON.stringify(ov.rows[0].cells) === '["1","0","0","2","0","0","3"]', `${rel}: site A counts (got ${JSON.stringify(ov.rows[0].cells)})`);
  // "אין גישה" (P008) waits for rescue like trapped (owner, 2026-11-19)
  assert(JSON.stringify(ov.rows[1].cells) === '["0","1","2","1","0","0","4"]', `${rel}: site B: trapped not urgent / not sorted, no access counted as trapped (got ${JSON.stringify(ov.rows[1].cells)})`);
  // Every casualty in exactly one column: the row adds up to the total (owner, 2026-11-19).
  ov.rows.forEach((r) => { const n = r.cells.map(Number); assert(n.slice(0, 6).reduce((a, b) => a + b, 0) === n[6], `${rel}: ${r.key} row adds up (got ${JSON.stringify(r.cells)})`); });
  assert(!ov.resp, `${rel}: responsibilities must be closed until the button is pressed`);
  // No T0 in the demo: trapped time counts from the first trapped casualty's registration, "at least".
  const demoTrap = await page.evaluate(() => document.querySelector('[data-rcc-incident-detail="SITE_A"] [data-rcc-trapped-since]')?.textContent || '');
  assert(demoTrap.includes('לכודים לפחות'), `${rel}: without T0 the trapped time says "at least" (got ${demoTrap})`);
  assert(ov.stripHidden, `${rel}: the English version banner is hidden on the RCC panel`);
  noTriage(await bodyText(page), `${rel} overview`);
  await page.click('[data-rcc-responsibilities]');
  assert(await page.locator('[data-rcc-responsibilities-panel]').isVisible(), `${rel}: the button opens the responsibilities`);
  await page.click('[data-rcc-responsibilities]');

  // 2. Evacuation messages: nothing on the first look; arrival at the evacuation point and handover do.
  assert(!(await page.locator('#rcc-evac-banner').isVisible()), `${rel}: no message on the first look`);
  await page.evaluate(() => {
    const y = patients.find((p) => p.id === 'y1'); y.evacPointArrivedAt = Date.now();
    patients.find((p) => p.id === 'r2').patientStatus = 'handed_over';
    renderRoleDashboard('rcc');
  });
  const after = await page.evaluate(() => [...document.querySelector('[data-rcc-incident-row="SITE_A"]').querySelectorAll('td')].map((td) => td.textContent.trim()));
  assert(JSON.stringify(after) === '["0","0","0","1","1","1","3"]', `${rel}: handed-over trapped patient leaves the trapped columns, arrival counted at the נאפ״ל, total kept (got ${JSON.stringify(after)})`);
  const extractedDemo = await page.evaluate(() => document.querySelector('[data-rcc-incident-detail="SITE_A"] [data-rcc-extracted]')?.textContent || '');
  assert(extractedDemo.includes('חולצו עד כה: 1 מתוך 1'), `${rel}: the phone remembers P002 was trapped (got ${extractedDemo})`);
  const msg = await page.evaluate(() => ({ banner: document.getElementById('rcc-evac-banner').innerText, feed: _rccEvacFeed.map((m) => `${m.visualId}:${m.text}`) }));
  assert(msg.banner.includes('P003 · הגיע לנאפ״ל') && msg.banner.includes('P002 · פונה לבית חולים'), `${rel}: banner names both patients (got ${msg.banner})`);
  assert(msg.feed.length === 2 && msg.feed.includes('P003:הגיע לנאפ״ל') && msg.feed.includes('P002:פונה לבית חולים'), `${rel}: both kept in the feed (got ${JSON.stringify(msg.feed)})`);
  await page.evaluate(() => renderRoleDashboard('rcc'));
  assert((await page.evaluate(() => _rccEvacFeed.length)) === 2, `${rel}: the same change is not announced twice`);
  await page.evaluate(() => dismissRccEvacBanner());

  // 3. Row opens the incident: evacuation order, type, building, site clear, close guard.
  await page.click('[data-rcc-incident-row="SITE_A"]');
  const inc = await page.evaluate(() => ({
    order: [...document.querySelectorAll('[data-rescue-priority]')].map((r) => r.querySelector('.role-row-title').textContent),
    type: document.querySelector('[data-rcc-type].rcc-selected')?.dataset.rccType,
    building: !!document.querySelector('[data-rcc-building]'),
    remaining: document.querySelector('[data-rcc-remaining]')?.dataset.rccRemaining,
    evacuated: document.querySelector('[data-rcc-evacuated] summary')?.textContent,
  }));
  assert(inc.order.length === 2 && inc.order[0].includes('P001') && inc.order[1].includes('P003'), `${rel}: incident patients in the shared evacuation order, evacuated ones apart (got ${JSON.stringify(inc.order)})`);
  assert(inc.type === 'missile_strike_structural_collapse' && inc.building, `${rel}: collapse type shows the building status (got ${JSON.stringify(inc)})`);
  assert(inc.remaining === '2' && inc.evacuated === 'פונו (1)', `${rel}: remaining and evacuated (got ${JSON.stringify(inc)})`);
  noTriage(await bodyText(page), `${rel} incident view`);
  await page.click('[data-rcc-building-status="stable"]');
  assert((await page.evaluate(() => ensureSiteStatusFields('SITE_A').buildingStatus)) === 'stable', `${rel}: building status set from the incident view`);
  await page.evaluate(() => document.getElementById('incident-type-brief-modal')?.classList.add('hidden'));
  await page.click('[data-rcc-close]');
  assert(await page.evaluate(() => !document.getElementById('incident-close-modal').classList.contains('hidden')), `${rel}: close with patients not handed over goes to the close guard`);
  await page.evaluate(() => hideIncidentCloseModal());
  await page.evaluate(() => { patients.filter((p) => (p.siteId || 'SITE_A') === 'SITE_A').forEach((p) => { p.patientStatus = 'handed_over'; }); renderRoleDashboard('rcc'); });
  await page.click('[data-rcc-site-clear]');
  await page.click('[data-rcc-close]');
  const closed = await page.evaluate(() => ({ status: ensureSiteStatusFields('SITE_A').incidentStatus, cleared: ensureSiteStatusFields('SITE_A').siteClear.cleared }));
  assert(closed.status === 'closed' && closed.cleared, `${rel}: all handed over: site clear and close (got ${JSON.stringify(closed)})`);

  // 4. A type without a building keeps the building status behind a button.
  await page.click('[data-rcc-all-incidents]');
  await page.click('[data-rcc-incident-row="SITE_B"]');
  assert(await page.locator('[data-rcc-building-expand]').isVisible() && !(await page.locator('[data-rcc-building]').count()), `${rel}: shooting: building status behind a button`);
  await page.click('[data-rcc-building-expand]');
  assert(await page.locator('[data-rcc-building]').isVisible(), `${rel}: the button opens the building status`);

  // 5. "חולץ" (owner, 2026-11-19): a trapped casualty extracted by the rescue chain goes to the
  // נאפ״ל to meet a medic: no longer trapped, on the way to the evacuation point, sent as PATIENT_EXTRACTED.
  assert(!(await page.locator('[data-rescue-extract="b1"]').count()), `${rel}: no "חולץ" for a casualty who is not trapped`);
  // Owner, 2026-11-19: an unsorted trapped casualty is not extracted before a medic checks them.
  for (const id of ['b3', 'b4']) {
    assert(!(await page.locator(`[data-rescue-extract="${id}"]`).count()) && (await page.locator(`[data-rescue-extract-blocked="${id}"]`).count()) === 1,
      `${rel}: ${id} (טרם מוין) has no "חולץ", only the medic-check note`);
  }
  await page.evaluate(() => rescueMarkExtracted('b3'));
  assert((await page.evaluate(() => patients.find((x) => x.id === 'b3').trapStatus)) === 'trapped', `${rel}: rescueMarkExtracted refuses an unsorted casualty`);
  // "בקש חובש לבדיקה": a medical request linked to the casualty, once.
  await page.click('[data-rescue-request-medic="b3"]');
  const req = await page.evaluate(() => reinforcementRequests.filter((r) => r.resourceType === 'extraction_medic').map((r) => `${r.linkedPatientIds[0]}:${r.reasonCodes[0]}:${r.urgency}`));
  assert(JSON.stringify(req) === '["b3:unsorted_trapped:high"]', `${rel}: extraction medic request (got ${JSON.stringify(req)})`);
  assert(await page.locator('[data-rescue-medic-requested="b3"]').count() === 1 && !(await page.locator('[data-rescue-request-medic="b3"]').count()), `${rel}: the button becomes "בקשה לחובש נשלחה"`);
  assert((await page.evaluate(() => getOutbox().filter((e) => e.type === 'MEDICAL_REINFORCEMENT_REQUESTED' && e.payload_json.resourceType === 'extraction_medic').length)) === 1, `${rel}: request queued for sync`);
  await page.click('[data-rescue-extract="b2"]');
  const ext = await page.evaluate(() => {
    const p = patients.find((x) => x.id === 'b2');
    const ev = getOutbox().filter((e) => e.type === 'PATIENT_EXTRACTED').map((e) => `${e.patient_id}:${e.payload_json.next}`);
    return { trap: p.trapStatus, stage: rescueEvacStage(p), ev, button: !!document.querySelector('[data-rescue-extract="b2"]'),
      row: document.querySelector('[data-rescue-priority] + *') ? '' : '', text: document.getElementById('role-dashboard-body').innerText };
  });
  assert(ext.trap === 'not_trapped' && ext.stage === 'moving' && !ext.button, `${rel}: extracted: freed, on the way to the נאפ״ל, button gone (got ${JSON.stringify({ trap: ext.trap, stage: ext.stage, button: ext.button })})`);
  assert(JSON.stringify(ext.ev) === '["b2:evac_point"]', `${rel}: PATIENT_EXTRACTED queued once (got ${JSON.stringify(ext.ev)})`);
  assert(ext.text.includes('P006') && ext.text.includes('בדרך לנאפ״ל') && ext.text.includes('חולץ '), `${rel}: the row says extracted and on the way to the נאפ״ל`);
  await page.click('[data-rcc-all-incidents]');
  const rowB = await page.evaluate(() => [...document.querySelector('[data-rcc-incident-row="SITE_B"]').querySelectorAll('td')].map((td) => td.textContent.trim()));
  assert(JSON.stringify(rowB) === '["0","0","2","2","0","0","4"]', `${rel}: site B after the extraction (got ${JSON.stringify(rowB)})`);
  const extB = await page.evaluate(() => document.querySelector('[data-rcc-incident-detail="SITE_B"] [data-rcc-extracted]')?.textContent || '');
  assert(extB.includes('חולצו עד כה: 1 מתוך 3'), `${rel}: extracted so far counts it (got ${extB})`);

  // 6. Trapped 60 minutes or more (from T0): a medic is present and records the extraction
  // (crush syndrome), whatever the priority. The rescue chain sees no "חולץ", only the call.
  await page.evaluate(() => {
    patients.push({ events: [], location: 'בניין 7', patientStatus: 'in_treatment', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', trapStatus: 'trapped', vitals: {}, createdAt: new Date().toISOString(), id: 'b5', visualId: 'P009', triage: 'red' });
    ensureSiteStatusFields('SITE_B').t0 = new Date(Date.now() - 70 * 60000).toISOString();
  });
  await page.click('[data-rcc-incident-row="SITE_B"]');
  const long = await page.evaluate(() => ({ need: document.querySelector('[data-rescue-extract-blocked="b5"]')?.dataset.rescueExtractNeed, button: !!document.querySelector('[data-rescue-extract="b5"]'),
    text: document.querySelector('[data-rescue-extract-blocked="b5"]')?.textContent || '' }));
  assert(long.need === 'medic_present' && !long.button && long.text.includes('תסמונת מעיכה'), `${rel}: 70 min trapped, urgent: medic present only (got ${JSON.stringify(long)})`);
  await page.click('[data-rescue-request-medic="b5"]');
  assert((await page.evaluate(() => reinforcementRequests.find((r) => r.linkedPatientIds[0] === 'b5')?.urgency)) === 'immediate', `${rel}: long entrapment call is immediate`);

  // The medic's phone: the call is a banner; the medic present marks the extraction.
  await page.evaluate(() => { goTo('dashboard'); renderMedicExtractionBanner(); });
  const calls = await page.evaluate(() => [...document.querySelectorAll('[data-medic-extraction-call]')].length);
  assert(calls === 2, `${rel}: both calls on the medic's banner (got ${calls})`);
  await page.evaluate(() => openPatient('b5'));
  await page.waitForSelector('[data-medic-extract="b5"]', { timeout: 3000 });
  await page.click('[data-medic-extract="b5"]');
  const med = await page.evaluate(() => { const p = patients.find((x) => x.id === 'b5'); return { trap: p.trapStatus, status: p.patientStatus, stage: rescueEvacStage(p) }; });
  assert(med.trap === 'not_trapped' && med.status === 'evacuating' && med.stage === 'moving', `${rel}: medic extraction: freed, on the way to the נאפ״ל (got ${JSON.stringify(med)})`);
  await page.evaluate(() => { goTo('dashboard'); renderMedicExtractionBanner(); });
  assert((await page.evaluate(() => [...document.querySelectorAll('[data-medic-extraction-call]')].length)) === 1, `${rel}: the medic's own casualty leaves the banner`);
  await page.evaluate(() => { goTo('role-dashboard'); startRoleDashboard('rcc'); });
  assert(!errors.length, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
}

async function checkSignedIn(browser, rel, file) {
  SERVER = newServer();
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));
  const { page, errors } = await openPhone(context, file);
  await login(page, 'rcc@test');
  await page.waitForFunction(() => document.querySelectorAll('[data-rcc-incident-row]').length === 2, null, { timeout: 5000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-rcc-incident-row]')].map((tr) => ({
    key: tr.dataset.rccIncidentRow, sub: document.querySelector(`[data-rcc-incident-detail="${tr.dataset.rccIncidentRow}"] .rcc-row-sub`).textContent, cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()) })));
  assert(rows[0].key === INC1 && JSON.stringify(rows[0].cells) === '["1","0","0","1","0","1","3"]', `${rel}: INC-1 counts from the rescue board (got ${JSON.stringify(rows[0])})`);
  assert(rows[0].sub.includes('מבנה: לא יציב') && rows[0].sub.includes('T0 לפני'), `${rel}: building status and T0 from incident_site_authority (got ${rows[0].sub})`);
  assert(JSON.stringify(rows[1].cells) === '["0","0","0","2","0","0","2"]' && rows[1].sub.includes('תאונת דרכים'), `${rel}: INC-2 row (got ${JSON.stringify(rows[1])})`);
  // Trapped since T0 unless recorded otherwise (owner 2026-11-19); INC-1's official T0 is 30 min old.
  const trap = await page.evaluate((id) => { const el = document.querySelector(`[data-rcc-incident-detail="${id}"] [data-rcc-trapped-since]`); return el && { since: el.dataset.rccTrappedSince, oldest: el.dataset.rccTrappedOldest, text: el.textContent }; }, INC1);
  assert(trap && trap.since === '30' && trap.oldest === '0' && trap.text.includes('(מ-T0)'), `${rel}: trapped time from T0 and oldest trapped update (got ${JSON.stringify(trap)})`);
  assert(!(await page.locator(`[data-rcc-incident-detail="${INC2}"] [data-rcc-trapped-since]`).count()), `${rel}: no trapped line without trapped casualties`);
  const extracted = await page.evaluate((id) => document.querySelector(`[data-rcc-incident-detail="${id}"] [data-rcc-extracted]`)?.textContent || '', INC1);
  assert(extracted.includes('חולצו עד כה: 1 מתוך 2'), `${rel}: extracted so far from was_trapped (database/085) (got ${extracted})`);
  noTriage(await bodyText(page), `${rel} signed-in overview`);

  // Server changes: P002-AA reaches the evacuation point (085), P001-BB is handed over, and a
  // patient from a server without 085 (no column) starts evacuating.
  SERVER.boards[INC1][1].evac_point_arrived_at = new Date().toISOString();
  SERVER.boards[INC2][0].evac_state = 'evacuated';
  const old = { ...SERVER.boards[INC2][1], evac_state: 'evacuating' }; delete old.evac_point_arrived_at;
  SERVER.boards[INC2][1] = old;
  await page.evaluate(() => refreshOpenIncidents());
  await page.waitForTimeout(200);
  const feed = await page.evaluate(() => _rccEvacFeed.map((m) => `${m.visualId}:${m.text}`).sort());
  assert(JSON.stringify(feed) === JSON.stringify(['P001-BB:פונה לבית חולים', 'P002-AA:הגיע לנאפ״ל', 'P002-BB:בפינוי לנאפ״ל']),
    `${rel}: messages from every incident (got ${JSON.stringify(feed)})`);
  assert(await page.locator('#rcc-evac-banner').isVisible(), `${rel}: banner shown`);
  const cellsAfter = await page.evaluate(() => [...document.querySelectorAll('[data-rcc-incident-row]')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()).join(',')));
  // INC-1: P002-AA arrived (085). INC-2: P001-BB to hospital, P002-BB evacuating on a server without
  // 085 cannot be placed at the נאפ״ל, so it stays in the on-site total.
  assert(JSON.stringify(cellsAfter) === JSON.stringify(['1,0,0,0,1,1,3', '0,0,0,1,0,1,2']), `${rel}: table after the server changes (got ${JSON.stringify(cellsAfter)})`);
  assert(SERVER.clinicalReads === 0, `${rel}: the RCC overview never reads the patients table (got ${SERVER.clinicalReads})`);

  // A row opens the incident; the strip leads back to every incident.
  await page.evaluate(() => dismissRccEvacBanner());
  await page.click(`[data-rcc-incident-row="${INC1}"]`);
  await page.waitForFunction((id) => activeIncident?.id === id && !!document.querySelector('[data-rcc-incident-view]'), INC1, { timeout: 5000 });
  await page.evaluate(() => pullProjectedPatientStateAll());
  await page.waitForTimeout(300);
  await page.evaluate(() => renderRoleDashboard('rcc'));
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-rescue-priority]')].map((r) => r.querySelector('.role-row-title').textContent));
  assert(order.length === 2 && order[0].includes('P001-AA') && order[1].includes('P002-AA'), `${rel}: incident view lists the board in evacuation order (got ${JSON.stringify(order)})`);
  assert((await bodyText(page)).includes('בנאפ״ל'), `${rel}: arrived patient shown at the evacuation point`);
  // "חולץ" signed in: sent for the server patient; the next board pull (the server has not
  // projected it yet) does not put the casualty back under the rubble.
  await page.click(`[data-rescue-extract="${pid(1)}"]`);
  await page.evaluate((id) => pullProjectedPatientState(id), INC1);
  await page.waitForTimeout(300);
  const ext = await page.evaluate((id) => ({ ev: getOutbox().filter((e) => e.type === 'PATIENT_EXTRACTED').map((e) => e.patient_id),
    stage: rescueEvacStage(patients.find((p) => p.id === id)), trap: patients.find((p) => p.id === id).trapStatus }), pid(1));
  assert(JSON.stringify(ext.ev) === JSON.stringify([pid(1)]) && ext.stage === 'moving' && ext.trap === 'not_trapped', `${rel}: signed-in extraction queued and kept over a pull (got ${JSON.stringify(ext)})`);
  // Access sync (V2.99.76): a medic's trapped / no-access mark is sent once the patient exists on
  // the server, as access_status 'blocked' for "אין גישה", and the server's "unknown" never wipes it.
  const sync = await page.evaluate((inc) => {
    const role = currentUser.role; currentUser.role = 'medic';
    patients.push({ id: 'acc-1', visualId: 'P090', siteId: 'SITE_A', incidentId: inc, trapStatus: 'access_blocked', accessibility: 'blocked', _serverVersion: 1, events: [], vitals: {} });
    patients.push({ id: 'acc-2', visualId: 'P091', siteId: 'SITE_A', incidentId: inc, trapStatus: 'trapped', events: [], vitals: {} }); // not on the server yet
    reconcileAccessSync(); reconcileAccessSync();
    const sent = getOutbox().filter((e) => e.type === 'PATIENT_ACCESS_UPDATED').map((e) => `${e.patient_id}:${e.payload_json.access_status}`);
    applyProjectedPatientState([{ id: 'acc-1', visual_id: 'P090', current_triage: null, current_status: 'identified', access_status: 'unknown', needs_full_assessment: true }]);
    const kept = patients.find((p) => p.id === 'acc-1').trapStatus;
    patients.splice(patients.findIndex((p) => p.id === 'acc-1'), 1); patients.splice(patients.findIndex((p) => p.id === 'acc-2'), 1);
    currentUser.role = role;
    return { sent, kept };
  }, INC1);
  assert(JSON.stringify(sync.sent) === '["acc-1:blocked"]', `${rel}: access sent once, only for a patient the server has (got ${JSON.stringify(sync.sent)})`);
  assert(sync.kept === 'access_blocked', `${rel}: the server's unknown access does not wipe the phone's mark (got ${sync.kept})`);

  await page.click('[data-rcc-all-incidents]');
  await page.waitForFunction(() => !activeIncident && document.querySelectorAll('[data-rcc-incident-row]').length === 2, null, { timeout: 5000 });
  assert(!errors.length, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
}

// RPC (owner, 2026-11-19): the same panel, only the incidents of the RPC's own platoon.
async function checkRpc(browser, rel, file) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const base = { events: [], location: 'בניין 3', patientStatus: 'in_treatment', trapStatus: 'trapped', vitals: {}, createdAt: new Date().toISOString() };
    patients.push({ ...base, id: 'ra', visualId: 'P001', triage: 'red', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A' });
    patients.push({ ...base, id: 'rb', visualId: 'P002', triage: 'red', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B' });
    goTo('demo'); startRoleDashboard('rpc');
  });
  const demoRows = await page.evaluate(() => [...document.querySelectorAll('[data-rcc-incident-row]')].map((r) => r.dataset.rccIncidentRow));
  assert(JSON.stringify(demoRows) === '["SITE_A"]', `${rel}: demo RPC sees its platoon's site only (got ${JSON.stringify(demoRows)})`);
  const title = await page.evaluate(() => document.getElementById('role-dashboard-body').innerText);
  assert(title.includes('כל האירועים במחלקה') && !title.includes('P002'), `${rel}: RPC table titled for the platoon, no other platoon's patient`);
  await context.close();

  SERVER = newServer();
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx2.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));
  const { page: p2, errors } = await openPhone(ctx2, file);
  await login(p2, 'rpc@test');
  await p2.waitForFunction(() => document.querySelectorAll('[data-rcc-incident-row]').length >= 1 && !!_rescueBoardsAt, null, { timeout: 5000 });
  await p2.waitForTimeout(200);
  const rows = await p2.evaluate(() => [...document.querySelectorAll('[data-rcc-incident-row]')].map((r) => r.dataset.rccIncidentRow));
  assert(JSON.stringify(rows) === JSON.stringify([INC1]), `${rel}: signed-in RPC sees its platoon's incident only (got ${JSON.stringify(rows)})`);
  assert(SERVER.clinicalReads === 0, `${rel}: the RPC panel never reads the patients table`);
  assert(!errors.length, `${rel}: page errors: ${errors.join(' | ')}`);
  await ctx2.close();
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const file of files) {
      const rel = path.relative(root, file);
      await checkDemo(browser, rel, file);
      await checkSignedIn(browser, rel, file);
      await checkRpc(browser, rel, file);
      console.log(`${rel}: RCC panel browser test passed`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
