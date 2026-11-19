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

const USERS = { 'rcc@test': { id: RCC, role: 'rcc', display_name: 'מ"פ חילוץ בדיקה' } };
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const b = (id, inc, visual, priority, evac, order, extra = {}) => ({ id, incident_id: inc, visual_id: visual, optional_name: null,
    identifying_description: `תיאור ${visual}`, location_json: { zone: 'קומה 1', label: 'קומה 1' }, access_status: 'free', trap_status: 'not_trapped',
    is_trapped: false, evac_state: evac, priority, evac_order: order, updated_at: new Date().toISOString(), version: 1, evac_point_arrived_at: null, ...extra });
  return {
    incidents: [
      { id: INC1, visual_id: 'INC-1', status: 'active', location_name: 'רחוב הרצל', address: null, incident_type: 'missile_strike_structural_collapse', t_zero: null, opened_at: new Date().toISOString(), patient_count: 3, is_member: false },
      { id: INC2, visual_id: 'INC-2', status: 'active', location_name: 'צומת גומא', address: null, incident_type: 'vehicle_accident', t_zero: null, opened_at: new Date().toISOString(), patient_count: 2, is_member: false },
    ],
    boards: {
      [INC1]: [
        b(pid(1), INC1, 'P001-AA', 'urgent', 'on_site', 1, { access_status: 'trapped', trap_status: 'trapped', is_trapped: true }),
        b(pid(2), INC1, 'P002-AA', 'not_urgent', 'evacuating', 2),
        b(pid(3), INC1, 'P003-AA', 'urgent', 'evacuated', 3),
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
    const rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true }));
    return { data: req.single ? rows[0] : rows, error: null };
  }
  if (req.table === 'incidents') {
    const rows = server.incidents.filter((i) => Object.entries(req.eq || {}).every(([c, v]) => i[c] === v));
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
  // columns (owner 2026-11-19): trapped urgent, trapped not urgent, trapped not sorted, everyone at
  // the site (being carried to the נאפ״ל included), at the נאפ״ל, evacuated to hospital
  assert(JSON.stringify(ov.rows[0].cells) === '["1","0","0","3","0","0"]', `${rel}: site A counts (got ${JSON.stringify(ov.rows[0].cells)})`);
  assert(JSON.stringify(ov.rows[1].cells) === '["0","1","1","3","0","0"]', `${rel}: site B: trapped not urgent / not sorted (got ${JSON.stringify(ov.rows[1].cells)})`);
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
  assert(JSON.stringify(after) === '["0","0","0","1","1","1"]', `${rel}: freed trapped patient leaves the trapped column, arrival counted at the נאפ״ל (got ${JSON.stringify(after)})`);
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
  assert(rows[0].key === INC1 && JSON.stringify(rows[0].cells) === '["1","0","0","2","0","1"]', `${rel}: INC-1 counts from the rescue board (got ${JSON.stringify(rows[0])})`);
  assert(rows[0].sub.includes('מבנה: לא יציב') && rows[0].sub.includes('T0 לפני'), `${rel}: building status and T0 from incident_site_authority (got ${rows[0].sub})`);
  assert(JSON.stringify(rows[1].cells) === '["0","0","0","2","0","0"]' && rows[1].sub.includes('תאונת דרכים'), `${rel}: INC-2 row (got ${JSON.stringify(rows[1])})`);
  // Trapped since T0 unless recorded otherwise (owner 2026-11-19); INC-1's official T0 is 30 min old.
  const trap = await page.evaluate((id) => { const el = document.querySelector(`[data-rcc-incident-detail="${id}"] [data-rcc-trapped-since]`); return el && { since: el.dataset.rccTrappedSince, oldest: el.dataset.rccTrappedOldest, text: el.textContent }; }, INC1);
  assert(trap && trap.since === '30' && trap.oldest === '0' && trap.text.includes('(מ-T0)'), `${rel}: trapped time from T0 and oldest trapped update (got ${JSON.stringify(trap)})`);
  assert(!(await page.locator(`[data-rcc-incident-detail="${INC2}"] [data-rcc-trapped-since]`).count()), `${rel}: no trapped line without trapped casualties`);
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
  assert(JSON.stringify(cellsAfter) === JSON.stringify(['1,0,0,1,1,1', '0,0,0,1,0,1']), `${rel}: table after the server changes (got ${JSON.stringify(cellsAfter)})`);
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
  await page.click('[data-rcc-all-incidents]');
  await page.waitForFunction(() => !activeIncident && document.querySelectorAll('[data-rcc-incident-row]').length === 2, null, { timeout: 5000 });
  assert(!errors.length, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const file of files) {
      const rel = path.relative(root, file);
      await checkDemo(browser, rel, file);
      await checkSignedIn(browser, rel, file);
      console.log(`${rel}: RCC panel browser test passed`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
