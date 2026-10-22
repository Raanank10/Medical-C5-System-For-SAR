// Real-browser test of the cross-device PC -> medic assignment (V2.99.30): three tabs in one
// browser context act as three phones (medic, PC, rescue) sharing one fake backend. The backend
// lives in this Node process and every tab reaches it through a Playwright binding, so all three
// see the same data the way phones see one server (shared browser storage between tabs was tried
// first and is not reliable: a tab could miss another tab's writes). Each tab's login lives in its
// own sessionStorage, like separate phones. The fake enforces the access rules the feature relies
// on, as verified live by rolled-back role impersonation (docs/ROLE_COMMAND_MODEL_v2.8.md):
// - incident_memberships: command roles may insert/update; a medic reads only its own rows
// - incidents: visible to blanket roles (cc/chamal/admin/rpc/rcc/physician) or members; updatable
//   by pc/cc/chamal/admin/physician/rpc/rcc only where visible; a medic cannot update an active one
// - profiles: command roles read all; a medic reads only itself
// It proves client behavior only, not the server; the server side was checked separately.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_medic_assignment_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const INC2 = '22222222-bbbb-4bbb-8bbb-222222222222';
const MEDIC = '11111111-1111-4111-8111-111111111111';
const PC = '22222222-2222-4222-8222-222222222222';
const RPC = '55555555-5555-4555-8555-555555555555';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש בדיקה' },
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'rpc@test': { id: RPC, role: 'rpc', display_name: 'מ"מ בדיקה' },
};
const COMMAND = ['pc', 'cc', 'chamal', 'admin', 'physician'];
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const INC_UPDATERS = ['pc', 'cc', 'chamal', 'admin', 'physician', 'rpc', 'rcc'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [
      { id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} },
      { id: INC2, visual_id: 'INC-TEST-2', status: 'active', location_name: 'מוקד בדיקה 2', address: null, incident_type: null, metadata: {} },
    ],
    members: [
      { incident_id: INC1, profile_id: PC, role_at_incident: 'pc', assigned_by: null, created_at: now },
      { incident_id: INC2, profile_id: MEDIC, role_at_incident: 'medic', assigned_by: null, created_at: now },
    ],
  };
}
// One request from a tab's fake client -> {data, error}, with the access rules applied.
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
    let rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true }));
    if (!COMMAND.includes(u.role)) rows = rows.filter((r) => r.id === u.id);
    rows = rows.filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const visible = server.incidents.filter((i) => canSee(i) && match(i));
    if (req.op === 'update') {
      const ok = INC_UPDATERS.includes(u.role);
      if (ok) visible.forEach((i) => Object.assign(i, clone(req.payload)));
      return { data: ok ? visible.map((i) => ({ id: i.id })) : [], error: null };
    }
    const data = req.single ? (visible[0] || null) : visible;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') {
      if (!COMMAND.includes(u.role)) return { data: null, error: { message: 'rls: insert denied' } };
      const p = clone(req.payload);
      const ex = server.members.find((r) => r.incident_id === p.incident_id && r.profile_id === p.profile_id);
      if (ex) { if (!req.ignoreDup) Object.assign(ex, p); } else server.members.push({ created_at: new Date().toISOString(), ...p });
      return { data: null, error: null };
    }
    let vis = server.members.filter((r) => COMMAND.includes(u.role) || r.profile_id === u.id).filter(match);
    if (req.order) vis.sort((a, c) => (a[req.order.c] > c[req.order.c] ? 1 : -1) * (req.order.asc ? 1 : -1));
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
  await page.route('**/functions/v1/sync-log**', (r) => r.request().method() === 'POST'
    ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: [], duplicates: [], rejected: [] }) })
    : r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) }));
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
let SERVER = null;
const db = async () => JSON.parse(JSON.stringify(SERVER));

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  // One shared fake server for all three phones in this run.
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // Phone 1, medic: working in incident 2.
  const medic = await openPhone(context, file);
  await login(medic.page, 'medic@test');
  await medic.page.evaluate((id) => enterIncidentFromPicker(id), INC2);
  await medic.page.waitForTimeout(300);
  assert(await medic.page.evaluate((id) => activeIncident?.id === id, INC2), `${rel}: medic must start in incident 2`);
  assert(!(await medic.page.locator('#assignment-switch-banner').isVisible()), `${rel}: no switch banner before any assignment`);

  // Phone 2, PC: enters incident 1 and assigns the medic to it from the medic-load board.
  const pc = await openPhone(context, file);
  await login(pc.page, 'pc@test');
  await pc.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await pc.page.waitForTimeout(300);
  await pc.page.evaluate(() => startRoleDashboard('pc'));
  await pc.page.waitForTimeout(200);
  await pc.page.locator('button:has-text("שייך חובש לאירוע")').first().click();
  await pc.page.waitForSelector('#medic-assign-real-wrap', { state: 'visible' });
  const options = await pc.page.locator('#medic-assign-real-medic option').allTextContents();
  assert(options.length === 1 && options[0].includes('חובש בדיקה'), `${rel}: PC must be offered exactly the real medic account (got ${JSON.stringify(options)})`);
  await pc.page.fill('#medic-assign-address', 'רחוב בדיקה 1');
  await pc.page.fill('#medic-assign-note', 'כניסה משער צפוני');
  await pc.page.click('#medic-assign-modal button:has-text("שייך לאירוע")');
  await pc.page.waitForTimeout(300);
  let state = await db();
  const mem = state.members.find((m) => m.incident_id === INC1 && m.profile_id === MEDIC);
  assert(mem && mem.assigned_by === PC, `${rel}: medic membership in incident 1 must carry assigned_by = PC`);
  const inc1 = state.incidents.find((i) => i.id === INC1);
  assert(inc1.address === 'רחוב בדיקה 1', `${rel}: assignment must write the address to the incident`);
  assert(inc1.metadata?.medic_assignments?.[MEDIC]?.note === 'כניסה משער צפוני', `${rel}: assignment must write the note to incident metadata`);
  assert(inc1.metadata.medic_assignments[MEDIC].assigned_by_name === 'חוג"ד בדיקה', `${rel}: the assigner's name must travel in metadata`);

  // Phone 3, rescue (rpc): sets the incident type on incident 1; it must reach the server.
  const rpc = await openPhone(context, file);
  await login(rpc.page, 'rpc@test');
  await rpc.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await rpc.page.waitForTimeout(300);
  await rpc.page.evaluate(() => { rescueSetIncidentType('rpc', 'explosion', 'SITE_A'); hideIncidentTypeBriefModal(); });
  await rpc.page.waitForTimeout(300);
  state = await db();
  assert(state.incidents.find((i) => i.id === INC1).incident_type === 'explosion', `${rel}: rescue's incident type must be written to the incident`);

  // Back on the medic phone: the next refresh shows the switch banner; switching pre-fills.
  await medic.page.evaluate(() => refreshIncidentContext());
  await medic.page.waitForTimeout(300);
  assert(await medic.page.locator('#assignment-switch-banner').isVisible(), `${rel}: medic in another incident must see the switch banner`);
  const bannerText = await medic.page.textContent('#assignment-switch-text');
  assert(bannerText.includes('חוג"ד בדיקה') && bannerText.includes('INC-TEST-1'), `${rel}: banner must name the assigner and the incident (got ${bannerText})`);
  await medic.page.click('#assignment-switch-banner button:has-text("עבור לאירוע")');
  await medic.page.waitForTimeout(500);
  assert(await medic.page.evaluate((id) => activeIncident?.id === id, INC1), `${rel}: switching must move the medic into incident 1`);
  assert(await medic.page.evaluate(() => activeScreenId() === 'enroute'), `${rel}: switching must open the Movement screen`);
  const card = (await medic.page.textContent('#enroute-assignment-card')).replace(/\s+/g, ' ');
  assert(card.includes('שובצת לאירוע ע״י חוג"ד בדיקה'), `${rel}: Movement card must say who assigned the medic (got ${card})`);
  assert(card.includes('כניסה משער צפוני'), `${rel}: Movement card must show the PC's note`);
  assert(card.includes('התרעה: פיצוץ'), `${rel}: Movement card must show rescue's incident type from the server`);
  assert((await medic.page.inputValue('#enroute-address')) === 'רחוב בדיקה 1', `${rel}: address must be pre-filled from the incident`);
  assert((await medic.page.inputValue('#enroute-notes')) === 'כניסה משער צפוני', `${rel}: notes must be pre-filled from the PC's note`);
  assert((await medic.page.getAttribute('#enroute-incident-type-grid .tap-btn.selected', 'data-incident-type')) === 'explosion', `${rel}: rescue's type must be selected`);
  assert(!(await medic.page.locator('#assignment-switch-banner').isVisible()), `${rel}: banner must hide after switching`);

  // Rescue wins: a different medic pick is reported, never applied, and nothing is written.
  await medic.page.click('#enroute-incident-type-grid [data-incident-type="vehicle_accident"]');
  await medic.page.waitForTimeout(200);
  assert(await medic.page.evaluate(() => siteAuthority.SITE_A.incidentType === 'explosion'), `${rel}: medic pick must not override rescue's type`);
  state = await db();
  assert(state.incidents.find((i) => i.id === INC1).incident_type === 'explosion', `${rel}: server type must stay rescue's`);

  // A medic cannot assign anyone, even by calling the code path directly.
  const medicCanAssign = await medic.page.evaluate(() => canAssignMedicsOnServer());
  assert(!medicCanAssign, `${rel}: a medic must not be offered server assignment`);

  const errors = [...medic.errors, ...pc.errors, ...rpc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: medic assignment cross-device browser test passed`);
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
