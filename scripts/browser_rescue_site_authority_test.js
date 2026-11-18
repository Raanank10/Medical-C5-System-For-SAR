// Real-browser test of rescue site authority across devices (V2.99.44, docs/GAP_CLOSURE_PLAN.md
// WP-8, database/060). An RPC, an RCC, a PC and a medic (four browser contexts, so four separate
// devices) share one fake backend in this Node process, the same harness as
// scripts/browser_reinforcement_sync_test.js. The fake mirrors what the real server does:
// - sync-log role gating for OFFICIAL_INCIDENT_OPENED_BY_RESCUE / BUILDING_STATUS_UPDATED /
//   SITE_CLEAR_CONFIRMED (SITE_AUTHORITY_EVENTS: pc, cc, rpc, rcc ...)
// - project_incident_site_authority() (database/060): only rpc/rcc/admin change the state; the
//   first T0 wins; the newest building status wins; the first site clear wins
// - incident_site_authority RLS: every member of the incident reads it.
// - WP-25 (database/089-090): several incident types per incident. Anyone adds a type; removing
//   follows the ladder rescue > PC/CC > medics against whoever added it (a medic only their own).
//   A medic's tap on someone else's type is a "not right" report that PC/CC/rescue keep or
//   accept (remove) by the same ladder. Boards send one change at a time (change_incident_type),
//   so a stale phone never drops a type someone else added. A medic whose type is removed is
//   told. A CC phone and a second medic join for this part.
// It proves client behavior only; database/060 and 086 themselves are exercised against real Postgres.
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
const CC = '55555555-5555-4555-8555-555555555555';
const MEDIC2 = '66666666-6666-4666-8666-666666666666';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'rpc@test': { id: RPC, role: 'rpc', display_name: 'מ"מ חילוץ בדיקה' },
  'rcc@test': { id: RCC, role: 'rcc', display_name: '<b>מ"פ</b> חילוץ' },
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש בדיקה' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ רפואה בדיקה' },
  'medic2@test': { id: MEDIC2, role: 'medic', display_name: 'חובשת שנייה' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const SITE = ['OFFICIAL_INCIDENT_OPENED_BY_RESCUE', 'BUILDING_STATUS_UPDATED', 'SITE_CLEAR_CONFIRMED'];
const TYPE_REPORT = ['INCIDENT_TYPE_SET_BY_MEDIC', 'INCIDENT_TYPE_MISMATCH_REPORTED'];
const TYPES = ['missile_strike_structural_collapse', 'mass_shooting', 'vehicle_accident', 'explosion'];
const ALLOWED = { rpc: SITE, rcc: SITE, pc: SITE, cc: SITE, medic: TYPE_REPORT };
const BUILDING = ['stable', 'unstable', 'progressive_collapse', 'safe_to_enter'];

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, incident_types: [], metadata: {} }],
    members: [RPC, RCC, PC, MEDIC, CC, MEDIC2].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    patients: [],
    events: [],
    site: {},
    typeReports: [],
    refusedTypeWrites: [],
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

// Ports of database/090: the ladder per type, the medic's event, change_incident_type, resolve.
const tier = (r) => (['rpc', 'rcc', 'admin'].includes(r) ? 3 : ['pc', 'cc', 'chamal'].includes(r) ? 2 : ['medic', 'paramedic', 'physician'].includes(r) ? 1 : 0);
const stampOf = (u, at) => ({ role: u.role, profile_id: u.id, by_label: u.display_name, at: at || new Date().toISOString() });
function mayRemove(inc, type, u) {
  const t = tier(u.role);
  if (t === 0) return false;
  if (t === 3) return true;
  const by = ((inc.metadata || {}).incident_types_set_by || {})[type] || {};
  if (t === 2) return tier(by.role) <= 2;
  return tier(by.role) === 1 && by.profile_id === u.id;
}
function setTypes(server, inc, next, u, at) {
  const old = inc.incident_types || [];
  const meta = inc.metadata || (inc.metadata = {});
  const setBy = { ...(meta.incident_types_set_by || {}) };
  const removed = { ...(meta.incident_types_removed || {}) };
  next.filter((t) => !old.includes(t)).forEach((t) => { setBy[t] = stampOf(u, at); });
  old.filter((t) => !next.includes(t)).forEach((t) => { delete setBy[t]; removed[t] = stampOf(u, at); });
  inc.metadata = { ...meta, incident_types_set_by: setBy, incident_types_removed: removed, incident_type_set_by: next[0] ? setBy[next[0]] : undefined };
  inc.incident_types = next;
  inc.incident_type = next[0] || null;
  for (const t of old.filter((x) => !next.includes(x))) {
    for (const r of server.typeReports.filter((x) => x.incident_id === inc.id && !x.resolved_at && x.reported_type === t)) Object.assign(r, { resolved_at: new Date().toISOString(), resolution: 'matched', resolved_by_role: u.role, resolved_by_name: u.display_name });
  }
}
function projectTypeReport(server, evt, actorId) {
  const u = userById(actorId);
  if (!TYPE_REPORT.includes(evt.type) || tier(u.role) !== 1) return;
  const p = evt.payload_json || {};
  const type = p.reportedType;
  if (!TYPES.includes(type)) return;
  const action = evt.type === 'INCIDENT_TYPE_SET_BY_MEDIC' && p.action === 'remove' ? 'remove' : 'add';
  const inc = server.incidents.find((i) => i.id === evt.incident_id);
  const types = inc.incident_types || [];
  const mine = server.typeReports.filter((r) => r.incident_id === inc.id && r.reported_by === actorId && r.reported_type === type && !r.resolved_at);
  const close = (resolution) => mine.forEach((x) => Object.assign(x, { resolved_at: new Date().toISOString(), resolution, resolved_by_role: u.role, resolved_by_name: u.display_name }));
  if (action === 'add') {
    close('superseded');
    if (types.includes(type)) return;
    const rm = ((inc.metadata || {}).incident_types_removed || {})[type];
    if (rm && Date.parse(evt.local_timestamp) < Date.parse(rm.at)) return;
    setTypes(server, inc, [...types, type], u, evt.local_timestamp);
    return;
  }
  if (!types.includes(type)) { close('matched'); return; }
  if (!mayRemove(inc, type, u)) {
    close('superseded');
    server.typeReports.push({ id: `rep-${server.typeReports.length + 1}`, incident_id: inc.id, reported_by: actorId, reported_by_role: u.role, reported_by_name: u.display_name,
      reported_type: type, types_at_report: [...types], reported_at: evt.local_timestamp, resolved_at: null, resolved_by_role: null, resolved_by_name: null, resolution: null });
    return;
  }
  setTypes(server, inc, types.filter((t) => t !== type), u, evt.local_timestamp);
}
function changeType(server, u, p) {
  const inc = server.incidents.find((i) => i.id === p.p_incident_id);
  if (!inc || tier(u.role) === 0) return { data: null, error: { code: '42501', message: `role ${u.role} may not change the incident type` } };
  const types = inc.incident_types || [];
  if (p.p_action === 'add' && !types.includes(p.p_type)) setTypes(server, inc, [...types, p.p_type], u);
  if (p.p_action === 'remove' && types.includes(p.p_type)) {
    if (!mayRemove(inc, p.p_type, u)) { server.refusedTypeWrites.push({ role: u.role, type: p.p_type }); return { data: null, error: { code: '42501', message: `role ${u.role} may not remove incident type ${p.p_type} (added at a higher level)` } }; }
    setTypes(server, inc, types.filter((t) => t !== p.p_type), u);
  }
  return { data: { incident_types: inc.incident_types, metadata: inc.metadata }, error: null };
}
function resolveTypeReport(server, u, p) {
  if (!['pc', 'cc', 'rpc', 'rcc', 'admin'].includes(u.role)) return { data: null, error: { code: '42501', message: 'only pc, cc, rpc, rcc or admin may close an incident type report' } };
  const r = server.typeReports.find((x) => x.id === p.p_id);
  if (!r) return { data: null, error: { message: 'not found' } };
  if (r.resolved_at) return { data: { id: r.id, changed: false, resolution: r.resolution }, error: null };
  const inc = server.incidents.find((i) => i.id === r.incident_id);
  const present = (inc.incident_types || []).includes(r.reported_type);
  if (p.p_action === 'accept' && present && !mayRemove(inc, r.reported_type, u)) return { data: null, error: { code: '42501', message: `role ${u.role} may not remove incident type (added at a higher level)` } };
  Object.assign(r, { resolved_at: new Date().toISOString(), resolution: p.p_action === 'accept' ? 'accepted' : 'kept_current', resolved_by_role: u.role, resolved_by_name: u.display_name });
  if (p.p_action === 'accept' && present) setTypes(server, inc, inc.incident_types.filter((t) => t !== r.reported_type), u);
  return { data: { id: r.id, changed: true, resolution: r.resolution, incident_types: inc.incident_types }, error: null };
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
    projectTypeReport(server, evt, userId);
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
    if (req.name === 'resolve_incident_type_report') return resolveTypeReport(server, u, p);
    if (req.name === 'change_incident_type') return changeType(server, u, p);
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true })).filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const vis = server.incidents.filter((i) => canSee(i) && match(i));
    if (req.op === 'update') {
      // incidents_update RLS (database/045); the type only changes through change_incident_type here.
      if (!['pc', 'cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'].includes(u.role)) return { data: [], error: null };
      const { incident_type: _t, incident_types: _ts, metadata, ...rest } = req.payload || {};
      for (const inc of vis) {
        const keep = inc.metadata || {};
        Object.assign(inc, rest);
        if (metadata) inc.metadata = { ...metadata, incident_types_set_by: keep.incident_types_set_by, incident_types_removed: keep.incident_types_removed, incident_type_set_by: keep.incident_type_set_by };
      }
      return { data: vis.map((i) => ({ id: i.id })), error: null };
    }
    const data = req.single ? (vis[0] || null) : vis;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'incident_site_authority') {
    // incident_site_authority_read (database/060): members of the incident.
    const rows = Object.values(server.site).filter((r) => canSee(server.incidents.find((i) => i.id === r.incident_id))).filter(match);
    return { data: clone(req.single ? (rows[0] || null) : rows), error: null };
  }
  if (req.table === 'incident_type_reports') {
    // incident_type_reports_read (database/090): members of the incident.
    const rows = server.typeReports.filter((r) => canSee(server.incidents.find((i) => i.id === r.incident_id))).filter(match)
      .sort((a, b) => Date.parse(b.reported_at) - Date.parse(a.reported_at));
    return { data: clone(rows), error: null };
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

  // 5. WP-25. Several types. Two medics on an empty incident: one adds shooting, the other adds
  //    explosion (a suicide bomber who opened fire and then exploded). Both stay, each with who added it.
  const cc = await phone();
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  const medic2 = await phone();
  await login(medic2.page, 'medic2@test');
  await enter(medic2.page);
  const inc = SERVER.incidents[0];
  const addedBy = (t) => (((inc.metadata || {}).incident_types_set_by || {})[t] || {});
  const typePull = async (page) => { await page.evaluate(async () => { const c = getSupabaseClient(); await pullActiveIncidentRow(c); await pullIncidentTypeReports(c); }); await page.waitForTimeout(150); };
  const note = (page) => page.evaluate(() => { renderEnrouteIncidentContext(); return document.getElementById('enroute-incident-type-note')?.textContent || ''; });
  const board = (page, role) => page.evaluate((r) => { renderRoleDashboard(r); return document.getElementById('screen-role-dashboard')?.innerText || ''; }, role);
  const buttons = (page) => page.evaluate(() => [...document.querySelectorAll('[data-type-report-action]')].map((b) => b.dataset.typeReportAction));
  const typeButton = (page, t) => page.evaluate((x) => { const b = document.querySelector(`[data-command-incident-type="${x}"]`); return b ? { on: b.dataset.on === '1', disabled: b.disabled } : null; }, t);
  const tap = (page, t) => page.evaluate((x) => { hideIncidentTypeBriefModal(); selectEnrouteIncidentType(x); hideIncidentTypeBriefModal(); }, t);
  const localTypes = (page) => page.evaluate(() => siteIncidentTypes('SITE_A'));
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  await tap(medic.page, 'mass_shooting');
  let n = await note(medic.page);
  assert(n.includes('ממתין לשליחה'), `${rel}: before the push the medic's note must say it is queued (got ${n})`);
  await syncAll(medic.page);
  await typePull(medic2.page);
  await tap(medic2.page, 'explosion');
  await syncAll(medic2.page);
  assert(sameSet(inc.incident_types, ['mass_shooting', 'explosion']) && addedBy('mass_shooting').profile_id === MEDIC && addedBy('explosion').profile_id === MEDIC2,
    `${rel}: both medics' types must be on the incident with who added each (got ${JSON.stringify(inc.incident_types)})`);
  assert(SERVER.typeReports.length === 0, `${rel}: adding a type is never a report`);
  await typePull(medic.page);
  assert(sameSet(await localTypes(medic.page), ['mass_shooting', 'explosion']), `${rel}: the first medic's phone must show both types`);
  assert((await medic.page.evaluate(() => incidentTypeLabel('SITE_A'))).includes('ירי המוני + פיצוץ'), `${rel}: the label must carry both types`);
  for (const [ph, role] of [[pc, 'pc'], [cc, 'cc']]) {
    await typePull(ph.page);
    const b = await board(ph.page, role);
    assert(b.includes('ירי המוני') && b.includes('פיצוץ') && b.includes('חובש בדיקה (חובש)') && b.includes('חובשת שנייה (חובש)'), `${rel}: the ${role} board must show both types and who added each`);
    const sh = await typeButton(ph.page, 'mass_shooting');
    assert(sh.on && !sh.disabled, `${rel}: ${role} may remove a medic's type`);
  }

  // 6. The second medic taps the first medic's type: not removed, a "not right" report instead.
  //    PC/CC/rescue see it; PC/CC may remove (a medic added it) or keep. The CC keeps it.
  await tap(medic2.page, 'mass_shooting');
  n = await note(medic2.page);
  assert(n.includes('דיווחת') && n.includes('ירי המוני'), `${rel}: the second medic's note must say they reported it (got ${n})`);
  await typePull(medic2.page); // a pull while the report is still unsent must not hide someone else's type
  assert((await localTypes(medic2.page)).includes('mass_shooting'), `${rel}: an unsent "not right" report must not hide the type on that phone`);
  await syncAll(medic2.page);
  let open = SERVER.typeReports.filter((r) => !r.resolved_at);
  assert(inc.incident_types.includes('mass_shooting') && open.length === 1 && open[0].reported_type === 'mass_shooting' && open[0].reported_by === MEDIC2,
    `${rel}: another medic's tap must be a report, not a removal (got ${JSON.stringify(inc.incident_types)}, ${JSON.stringify(open)})`);
  for (const [ph, role] of [[pc, 'pc'], [cc, 'cc'], [rpc, 'rpc'], [rcc, 'rcc']]) {
    await typePull(ph.page);
    const b = await board(ph.page, role);
    assert(b.includes('בקשה להסיר סוג אירוע') && b.includes('חובשת שנייה'), `${rel}: the ${role} board must show the report`);
    const acts = await buttons(ph.page);
    assert(acts.includes('accept') && acts.includes('keep'), `${rel}: ${role} may remove or keep a medic's type (got ${acts})`);
  }
  const pcAlerts = await pc.page.evaluate(() => buildAlertObjects().filter((a) => a.type === 'INCIDENT_TYPE_MISMATCH').map((a) => a.title));
  assert(pcAlerts.length === 1 && pcAlerts[0].includes('בקשה להסיר'), `${rel}: the PC strip must carry one line (got ${JSON.stringify(pcAlerts)})`);
  await board(cc.page, 'cc');
  await cc.page.evaluate(() => document.querySelector('[data-type-report-action="keep"]').click());
  await cc.page.waitForTimeout(400);
  assert(open[0].resolution === 'kept_current' && inc.incident_types.includes('mass_shooting'), `${rel}: the CC's keep closes it and the type stays`);
  await typePull(medic2.page);
  n = await note(medic2.page);
  assert(n.includes('נבדק') && n.includes('הסוג נשאר'), `${rel}: the second medic must see the report was reviewed (got ${n})`);

  // 7. The first medic removes their own type: gone everywhere.
  await tap(medic.page, 'mass_shooting');
  await syncAll(medic.page);
  assert(sameSet(inc.incident_types, ['explosion']), `${rel}: a medic must remove a type they added (got ${JSON.stringify(inc.incident_types)})`);

  // 8. A stale PC phone (has not seen a new type) adds one: the type it never saw survives.
  await tap(medic.page, 'vehicle_accident');
  await syncAll(medic.page);
  assert(inc.incident_types.includes('vehicle_accident'), `${rel}: the medic's new type must be on the server`);
  await pc.page.evaluate(() => commandSetIncidentType('missile_strike_structural_collapse'));
  await pc.page.waitForTimeout(500);
  assert(sameSet(inc.incident_types, ['explosion', 'vehicle_accident', 'missile_strike_structural_collapse']), `${rel}: a stale PC phone must not drop a type it had not seen (got ${JSON.stringify(inc.incident_types)})`);
  assert(addedBy('missile_strike_structural_collapse').role === 'pc', `${rel}: the PC's type is stamped PC`);
  // The PC removes the second medic's explosion: that medic is told.
  await typePull(pc.page);
  await pc.page.evaluate(() => commandSetIncidentType('explosion'));
  await pc.page.waitForTimeout(500);
  assert(!inc.incident_types.includes('explosion'), `${rel}: the PC may remove a medic's type`);
  await medic2.page.evaluate(() => { window.__toasts = []; const t = window.toast; window.toast = (m) => { window.__toasts.push(m); return t(m); }; });
  await typePull(medic2.page);
  const toasts = await medic2.page.evaluate(() => window.__toasts);
  assert(toasts.some((m) => m.includes('שהוספת הוסר ע״י') && m.includes('פיצוץ')), `${rel}: the medic must be told their type was removed (got ${JSON.stringify(toasts)})`);
  n = await note(medic2.page);
  assert(n.includes('שהוספת הוסר ע״י'), `${rel}: the Movement screen must say who removed it (got ${n})`);

  // 9. Rescue adds a type: PC/CC cannot remove it, not from the button, not through the server;
  //    a medic's report on it can only be kept by PC; rescue removes it.
  await typePull(rcc.page);
  await rcc.page.evaluate(() => { rescueSetIncidentType('rcc', 'mass_shooting', 'SITE_A'); hideIncidentTypeBriefModal(); });
  await rcc.page.waitForTimeout(500);
  assert(inc.incident_types.includes('mass_shooting') && addedBy('mass_shooting').role === 'rcc', `${rel}: rescue adds a type`);
  await typePull(pc.page);
  await board(pc.page, 'pc');
  let sh = await typeButton(pc.page, 'mass_shooting');
  assert(sh.on && sh.disabled, `${rel}: the PC's button for rescue's type must be locked`);
  await pc.page.evaluate(() => commandSetIncidentType('mass_shooting'));
  await pc.page.waitForTimeout(300);
  assert(inc.incident_types.includes('mass_shooting'), `${rel}: the PC's button must not remove rescue's type`);
  await pc.page.evaluate(() => queueIncidentTypeChange(activeIncident.id, 'mass_shooting', 'remove', 'pc'));
  await pc.page.waitForTimeout(500);
  assert(inc.incident_types.includes('mass_shooting') && SERVER.refusedTypeWrites.some((w) => w.role === 'pc'), `${rel}: the server must refuse a PC removing rescue's type`);
  assert((await localTypes(pc.page)).includes('mass_shooting'), `${rel}: after the refusal the PC's phone must show the type again`);
  await typePull(medic.page);
  await tap(medic.page, 'mass_shooting');
  await syncAll(medic.page);
  await typePull(pc.page);
  await board(pc.page, 'pc');
  let acts = await buttons(pc.page);
  assert(acts.includes('keep') && !acts.includes('accept'), `${rel}: over rescue's type the PC may only keep (got ${acts})`);
  await typePull(rpc.page);
  await board(rpc.page, 'rpc');
  acts = await buttons(rpc.page);
  assert(acts.includes('accept'), `${rel}: rescue may remove rescue's type`);
  await rpc.page.evaluate(() => document.querySelector('[data-type-report-action="accept"]').click());
  await rpc.page.waitForTimeout(400);
  assert(!inc.incident_types.includes('mass_shooting'), `${rel}: the RPC's accept must remove the type`);
  await typePull(medic.page);
  n = await note(medic.page);
  assert(n.includes('הוסר') && n.includes('לפי הדיווח שלך'), `${rel}: the medic must see their report led to the removal (got ${n})`);

  assert(SERVER.rejected.length === 0, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...rpc.errors, ...pc.errors, ...medic.errors, ...rcc.errors, ...cc.errors, ...medic2.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: rescue site authority + several incident types with the authority ladder (WP-25) cross-device browser test passed`);
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
