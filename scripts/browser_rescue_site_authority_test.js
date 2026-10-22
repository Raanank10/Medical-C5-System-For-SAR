// Real-browser test of rescue site authority across devices (V2.99.44, docs/GAP_CLOSURE_PLAN.md
// WP-8, database/060). An RPC, an RCC, a PC and a medic (four browser contexts, so four separate
// devices) share one fake backend in this Node process, the same harness as
// scripts/browser_reinforcement_sync_test.js. The fake mirrors what the real server does:
// - sync-log role gating for OFFICIAL_INCIDENT_OPENED_BY_RESCUE / BUILDING_STATUS_UPDATED /
//   SITE_CLEAR_CONFIRMED (SITE_AUTHORITY_EVENTS: pc, cc, rpc, rcc ...)
// - project_incident_site_authority() (database/060): only rpc/rcc/admin change the state; the
//   first T0 wins; the newest building status wins; the first site clear wins
// - incident_site_authority RLS: every member of the incident reads it.
// It proves client behavior only; database/060 itself is exercised against real Postgres.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_rescue_site_authority_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const RPC = '11111111-1111-4111-8111-111111111111';
const RCC = '22222222-2222-4222-8222-222222222222';
const PC = '33333333-3333-4333-8333-333333333333';
const MEDIC = '44444444-4444-4444-8444-444444444444';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'rpc@test': { id: RPC, role: 'rpc', display_name: 'מ"מ חילוץ בדיקה' },
  'rcc@test': { id: RCC, role: 'rcc', display_name: '<b>מ"פ</b> חילוץ' },
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש בדיקה' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const SITE = ['OFFICIAL_INCIDENT_OPENED_BY_RESCUE', 'BUILDING_STATUS_UPDATED', 'SITE_CLEAR_CONFIRMED'];
const ALLOWED = { rpc: SITE, rcc: SITE, pc: SITE, medic: [] };
const BUILDING = ['stable', 'unstable', 'progressive_collapse', 'safe_to_enter'];

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [RPC, RCC, PC, MEDIC].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    patients: [],
    events: [],
    site: {},
    rejected: [],
  };
}

// Port of project_incident_site_authority() (database/060).
function projectSite(server, evt, actorId) {
  const u = userById(actorId);
  if (!SITE.includes(evt.type) || !['rpc', 'rcc', 'admin'].includes(u.role)) return;
  const row = server.site[evt.incident_id] || (server.site[evt.incident_id] = { incident_id: evt.incident_id });
  const p = evt.payload_json || {};
  if (evt.type === 'OFFICIAL_INCIDENT_OPENED_BY_RESCUE') {
    if (row.official_t0) return;
    const t0 = Date.parse(p.t0) ? p.t0 : evt.local_timestamp;
    Object.assign(row, { official_t0: t0, official_by_role: u.role, official_by_name: u.display_name, official_at: evt.local_timestamp });
  } else if (evt.type === 'BUILDING_STATUS_UPDATED') {
    if (!BUILDING.includes(p.status)) return;
    if (row.building_status_at && Date.parse(evt.local_timestamp) < Date.parse(row.building_status_at)) return;
    Object.assign(row, { building_status: p.status, building_status_by_role: u.role, building_status_by_name: u.display_name, building_status_at: evt.local_timestamp });
  } else if (!row.site_cleared_at) {
    Object.assign(row, { site_cleared_at: evt.local_timestamp, site_cleared_by_role: u.role, site_cleared_by_name: u.display_name });
  }
}

function push(server, userId, body) {
  const u = userById(userId);
  const accepted = []; const rejected = [];
  for (const e of body.events || []) {
    if (!u || !(ALLOWED[u.role] || []).includes(e.type)) { rejected.push({ local_event_id: e.local_event_id, terminal: true, error_code: 'FORBIDDEN_ACTOR_ROLE' }); server.rejected.push({ role: u?.role, type: e.type }); continue; }
    if (server.events.some((x) => x.device_id === body.device_id && x.local_event_id === e.local_event_id)) { accepted.push({ local_event_id: e.local_event_id }); continue; }
    const evt = { ...e, device_id: body.device_id, incident_id: body.incident_id, actor_id: userId };
    server.events.push(evt);
    projectSite(server, evt, userId);
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
  if (req.table === 'incident_site_authority') {
    // incident_site_authority_read (database/060): members of the incident.
    const rows = Object.values(server.site).filter((r) => canSee(server.incidents.find((i) => i.id === r.incident_id))).filter(match);
    return { data: clone(req.single ? (rows[0] || null) : rows), error: null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') return { data: null, error: null };
    let vis = server.members.filter((r) => r.profile_id === u.id || ['pc', 'cc'].includes(u.role)).filter(match);
    if (req.limit) vis = vis.slice(0, req.limit);
    return { data: clone(req.single ? (vis[0] || null) : vis), error: null };
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

async function pullSite(page) {
  await page.evaluate(async () => { await pullIncidentSiteAuthority(getSupabaseClient()); });
  await page.waitForTimeout(150);
}
const siteLine = (page) => page.evaluate(() => siteStatusSummaryLine('SITE_A'));
const siteState = (page) => page.evaluate(() => { const s = ensureSiteStatusFields('SITE_A'); return { t0: s.t0, building: s.buildingStatus, cleared: !!s.siteClear?.cleared }; });

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

  // 1. RPC declares the incident official and reports the building unstable.
  const rpc = await phone();
  await login(rpc.page, 'rpc@test');
  await enter(rpc.page);
  await rpc.page.evaluate(() => { rescueOpenOfficialIncident('rpc', 'SITE_A'); rescueUpdateBuildingStatus('rpc', 'unstable', 'SITE_A'); });
  await syncAll(rpc.page);
  const site = SERVER.site[INC1];
  assert(site && site.official_t0 && site.building_status === 'unstable' && site.building_status_by_role === 'rpc', `${rel}: the rescue state must reach the server (got ${JSON.stringify(site)})`);
  const t0 = site.official_t0;

  // 2. PC and medic on their own phones see it, with who set it.
  const pc = await phone();
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  await pullSite(pc.page);
  let st = await siteState(pc.page);
  assert(st.t0 === t0 && st.building === 'unstable' && !st.cleared, `${rel}: PC must see T0 and the building status (got ${JSON.stringify(st)})`);
  let line = await siteLine(pc.page);
  assert(line.includes('לא יציב') && line.includes('חילוץ בדיקה (מ״מ)'), `${rel}: PC's site line must show the status and who set it (got ${line})`);
  const pcBoard = await pc.page.evaluate(() => { renderRoleDashboard('pc'); return document.getElementById('screen-role-dashboard')?.innerText || ''; });
  assert(pcBoard.includes('לא יציב'), `${rel}: the PC dashboard must show the building status`);
  const medic = await phone();
  await login(medic.page, 'medic@test');
  await enter(medic.page);
  await pullSite(medic.page);
  st = await siteState(medic.page);
  assert(st.building === 'unstable' && st.t0 === t0, `${rel}: the medic must see the rescue state (got ${JSON.stringify(st)})`);

  // 3. A PC cannot change rescue's building status or clear the site: the events are kept, the state is not.
  await pc.page.evaluate(() => { rescueUpdateBuildingStatus('pc', 'safe_to_enter', 'SITE_A'); rescueConfirmSiteClear('pc', 'SITE_A'); });
  await syncAll(pc.page);
  assert(site.building_status === 'unstable' && !site.site_cleared_at, `${rel}: a PC's site-authority event must not change the state (got ${JSON.stringify(site)})`);
  assert(SERVER.events.filter((e) => e.actor_id === PC).length === 2, `${rel}: the PC's events still stay in the event log`);
  await pullSite(pc.page);
  assert((await siteState(pc.page)).building === 'unstable', `${rel}: after the pull the PC's phone must follow the server`);

  // 4. RCC on another phone: an unsent change wins until pushed; then the newest status wins
  //    everywhere, a second T0 does not move the first, and the site clear reaches the PC.
  const rcc = await phone();
  await login(rcc.page, 'rcc@test');
  await enter(rcc.page);
  await rcc.page.evaluate(() => { rescueUpdateBuildingStatus('rcc', 'safe_to_enter', 'SITE_A'); rescueOpenOfficialIncident('rcc', 'SITE_A'); });
  await pullSite(rcc.page);
  assert((await siteState(rcc.page)).building === 'safe_to_enter', `${rel}: an unsent local building status must not be overwritten by the pull`);
  await syncAll(rcc.page);
  assert(site.building_status === 'safe_to_enter' && site.official_t0 === t0, `${rel}: the newer status wins and the first T0 stays (got ${JSON.stringify(site)})`);
  await rcc.page.evaluate(() => rescueConfirmSiteClear('rcc', 'SITE_A'));
  await syncAll(rcc.page);
  await pullSite(pc.page);
  st = await siteState(pc.page);
  line = await siteLine(pc.page);
  assert(st.building === 'safe_to_enter' && st.cleared && st.t0 === t0, `${rel}: PC must see the RCC's changes (got ${JSON.stringify(st)})`);
  assert(line.includes('אתר: נקי') && line.includes('האתר הוכרז נקי'), `${rel}: the site line must show the clear and name it as the latest change (got ${line})`);
  assert(!/[<>]/.test(line), `${rel}: a remote display name must arrive without markup (got ${line})`);
  await pullSite(rpc.page);
  assert((await siteState(rpc.page)).building === 'safe_to_enter', `${rel}: the RPC's phone must follow the newer RCC status`);

  assert(SERVER.rejected.length === 0, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...rpc.errors, ...pc.errors, ...medic.errors, ...rcc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: rescue site authority cross-device browser test passed`);
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : { channel: 'chromium' });
  try {
    for (const file of files) await checkFile(browser, file);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
