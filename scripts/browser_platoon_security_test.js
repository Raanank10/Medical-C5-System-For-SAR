// Real-browser test of the platoon security scope's client side (database/045, V2.99.33; platoons
// as real units since database/053, V2.99.39): CC, PC, RPC and medic phones share one fake backend
// in this Node process (same harness as scripts/browser_medic_assignment_test.js). The fake
// enforces the database/053 rules the client depends on: a pc / rpc reaches its own platoon's
// sites and the ones it belongs to; no self-join elsewhere; list_open_incidents scoped; profiles
// readable by a PC only for itself and its own platoon; memberships written by a PC only for its
// own platoon's medics; create_platoon / set_profile_platoon / set_incident_platoon for
// company-level command only. The SQL itself was exercised against the live database inside
// rolled-back transactions (docs/RLS_AUDIT_v1.md, database/053 follow-up).
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_platoon_security_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html'), path.join(root, 'demo', 'rescue-app.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111'; // PC1's site
const INC2 = '22222222-bbbb-4bbb-8bbb-222222222222'; // PC2's site
const CC = '33333333-3333-4333-8333-333333333333';
const PC1 = '22222222-2222-4222-8222-222222222222';
const PC2 = '44444444-4444-4444-8444-444444444444';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '55555555-5555-4555-8555-555555555555';
const RPC1 = '66666666-6666-4666-8666-666666666666';
const PLA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PLB = 'bbbbbbbb-0000-4000-8000-00000000000b';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'pc1@test': { id: PC1, role: 'pc', display_name: 'חוג"ד א' },
  'pc2@test': { id: PC2, role: 'pc', display_name: 'חוג"ד ב' },
  'm1@test': { id: M1, role: 'medic', display_name: 'חובש א' },
  'm2@test': { id: M2, role: 'medic', display_name: 'חובש ב' },
  'rpc1@test': { id: RPC1, role: 'rpc', display_name: 'מ"מ א' },
};
const COMPANY = ['cc', 'chamal', 'admin', 'physician'];
const BLANKET = ['cc', 'chamal', 'admin', 'rcc', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [
      { id: INC1, visual_id: 'INC-PLT-A', status: 'active', location_name: 'מוקד מחלקה א', address: null, incident_type: null, metadata: {}, platoon_id: PLA },
      { id: INC2, visual_id: 'INC-PLT-B', status: 'active', location_name: 'מוקד מחלקה ב', address: null, incident_type: null, metadata: {}, platoon_id: PLB },
    ],
    members: [
      { incident_id: INC1, profile_id: PC1, role_at_incident: 'pc', assigned_by: PC1, created_at: now },
      { incident_id: INC2, profile_id: PC2, role_at_incident: 'pc', assigned_by: PC2, created_at: now },
    ],
    platoons: [{ id: PLA, name: 'מחלקה א', is_active: true }, { id: PLB, name: 'מחלקה ב', is_active: true }],
    roster: { [PC1]: PLA, [M1]: PLA, [RPC1]: PLA, [PC2]: PLB, [M2]: null }, // M2 starts without a platoon
  };
}
function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const match = (row) => Object.entries(req.eq || {}).every(([c, v]) => row[c] === v)
    && Object.entries(req.in || {}).every(([c, v]) => v.includes(row[c]))
    && (req.notNull || []).every((c) => row[c] != null);
  const member = (incId, uid = u.id) => server.members.some((m) => m.incident_id === incId && m.profile_id === uid);
  const myPlatoon = server.roster[u.id] || null;
  const canSee = (inc) => BLANKET.includes(u.role) || member(inc.id)
    || (['pc', 'rpc'].includes(u.role) && !!myPlatoon && inc.platoon_id === myPlatoon);
  const denied = (msg) => ({ data: null, error: { code: '42501', message: msg } });
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') {
      return { data: clone(server.incidents.filter((i) => i.status === 'active' && canSee(i)).map((i) => ({ ...i, patient_count: 0, is_member: member(i.id) }))), error: null };
    }
    if (req.name === 'join_incident') {
      if (['pc', 'rpc', 'medic', 'paramedic'].includes(u.role) && !canSee(server.incidents.find((i) => i.id === p.p_incident_id) || {})) return denied('assignment required');
      if (!member(p.p_incident_id)) server.members.push({ incident_id: p.p_incident_id, profile_id: u.id, role_at_incident: u.role, assigned_by: u.id, created_at: new Date().toISOString() });
      return { data: { id: p.p_incident_id }, error: null };
    }
    if (req.name === 'create_platoon') {
      if (!COMPANY.includes(u.role)) return denied('only company-level command');
      const row = { id: 'cccccccc-0000-4000-8000-' + String(server.platoons.length).padStart(12, '0'), name: p.p_name, is_active: true };
      server.platoons.push(row);
      return { data: { id: row.id, name: row.name }, error: null };
    }
    if (req.name === 'set_profile_platoon') {
      if (!COMPANY.includes(u.role)) return denied('only company-level command');
      server.roster[p.p_profile_id] = p.p_platoon_id;
      return { data: { profile_id: p.p_profile_id }, error: null };
    }
    if (req.name === 'set_incident_platoon') {
      if (!COMPANY.includes(u.role) && u.role !== 'rcc') return denied('only company-level command');
      server.incidents.find((i) => i.id === p.p_incident_id).platoon_id = p.p_platoon_id;
      return { data: { incident_id: p.p_incident_id }, error: null };
    }
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    let rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true, platoon_id: server.roster[x.id] || null }));
    if (!COMPANY.includes(u.role)) rows = rows.filter((r) => r.id === u.id || (u.role === 'pc' && !!myPlatoon && r.platoon_id === myPlatoon));
    rows = rows.filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'platoons') return { data: clone(server.platoons), error: null };
  if (req.table === 'incidents') {
    const visible = server.incidents.filter((i) => canSee(i) && match(i));
    if (req.op === 'update') { visible.forEach((i) => Object.assign(i, clone(req.payload))); return { data: visible.map((i) => ({ id: i.id })), error: null }; }
    const data = req.single ? (visible[0] || null) : visible;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') {
      const r = clone(req.payload);
      const target = userById(r.profile_id);
      const pcOk = u.role === 'pc' && r.profile_id !== u.id && ['medic', 'paramedic'].includes(target?.role)
        && (member(r.incident_id) || server.incidents.find((i) => i.id === r.incident_id)?.platoon_id === myPlatoon)
        && !!myPlatoon && server.roster[r.profile_id] === myPlatoon;
      if (!COMPANY.includes(u.role) && !pcOk) return denied('new row violates row-level security policy');
      const ex = server.members.find((m) => m.incident_id === r.incident_id && m.profile_id === r.profile_id);
      if (ex) Object.assign(ex, r); else server.members.push({ created_at: new Date().toISOString(), ...r });
      return { data: null, error: null };
    }
    let vis = server.members.filter((r) => r.profile_id === u.id || COMPANY.includes(u.role) || (u.role === 'pc' && member(r.incident_id))).filter(match);
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
  const toasts = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/functions/v1/sync-log**', (r) => r.request().method() === 'POST'
    ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: [], duplicates: [], rejected: [] }) })
    : r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) }));
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
let SERVER = null;

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // PC2 cannot reach PC1's site: it is not listed, and a direct join is refused with a clear message.
  const pc2 = await openPhone(context, file);
  await login(pc2.page, 'pc2@test');
  const listed = await pc2.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(!listed.includes(INC1), `${rel}: PC2 must not see PC1's site in the picker (got ${JSON.stringify(listed)})`);
  await pc2.page.evaluate((id) => { _openIncidents.push({ id, visual_id: 'X', status: 'active', is_member: false }); return enterIncidentFromPicker(id); }, INC1);
  await pc2.page.waitForTimeout(300);
  assert(await pc2.page.evaluate((id) => activeIncident?.id !== id, INC1), `${rel}: PC2 must not enter PC1's site`);
  assert(pc2.toasts.some((t) => t.includes('נדרש שיבוץ')), `${rel}: a refused join must say an assignment is needed (got ${JSON.stringify(pc2.toasts)})`);
  assert(!SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === PC2), `${rel}: no membership may be created by a refused join`);

  // RPC1 (platoon A, no membership): reaches its platoon's site only (database/053).
  const rpc1 = await openPhone(context, file);
  await login(rpc1.page, 'rpc1@test');
  const rpcListed = await rpc1.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(rpcListed.includes(INC1) && !rpcListed.includes(INC2), `${rel}: RPC must see exactly its platoon's site (got ${JSON.stringify(rpcListed)})`);
  await rpc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await rpc1.page.waitForTimeout(300);
  await rpc1.page.evaluate(() => pullIncidentAssignmentState());
  assert(await rpc1.page.evaluate(() => _myPlatoonId === null ? 'none' : platoonName(_myPlatoonId)) === 'מחלקה א', `${rel}: RPC must know its platoon`);

  // CC: roster panel creates a platoon, places M2 in platoon A, shows the site's platoon; CC can
  // assign PC2 into PC1's site; the CC dashboard lists the real platoons, not the demo ones.
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await cc.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await cc.page.waitForTimeout(300);
  await cc.page.evaluate(() => startRoleDashboard('cc'));
  await cc.page.waitForSelector('[data-roster-member]', { timeout: 5000 });
  assert(await cc.page.inputValue(`[data-incident-platoon="${INC1}"]`) === PLA, `${rel}: the roster panel must show the site's platoon`);
  await cc.page.fill('#new-platoon-name', 'מחלקה ג');
  await cc.page.evaluate(() => createPlatoonFromPanel());
  await cc.page.waitForTimeout(300);
  assert(SERVER.platoons.some((p) => p.name === 'מחלקה ג'), `${rel}: CC must be able to create a platoon`);
  await cc.page.waitForSelector(`[data-roster-member="${M2}"]`, { timeout: 5000 });
  await cc.page.selectOption(`[data-roster-member="${M2}"]`, PLA);
  await cc.page.waitForTimeout(300);
  assert(SERVER.roster[M2] === PLA, `${rel}: CC roster change must reach the server`);
  const ccPlatoons = await cc.page.evaluate(() => commandPlatoons().map((p) => p.name));
  assert(ccPlatoons.includes('מחלקה א') && ccPlatoons.includes('מחלקה ב') && ccPlatoons.includes('מחלקה ג') && !ccPlatoons.includes('מחלקה רפואית א'),
    `${rel}: CC must see the real platoons, not the demo list (got ${JSON.stringify(ccPlatoons)})`);
  const ccOptions = await cc.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.role); });
  assert(ccOptions.includes('pc'), `${rel}: CC must be offered PC accounts to assign`);
  await cc.page.evaluate((id) => assignRealMedic(id, '', ''), PC2);
  assert(SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === PC2 && m.assigned_by === CC), `${rel}: CC must be able to assign a PC to a site`);

  // PC1: sees only its own platoon to assign; cannot change the roster; sees its platoon's name.
  const pc1 = await openPhone(context, file);
  await login(pc1.page, 'pc1@test');
  await pc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await pc1.page.waitForTimeout(300);
  const pc1Options = await pc1.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.id); });
  assert(pc1Options.length === 2 && pc1Options.includes(M1) && pc1Options.includes(M2), `${rel}: PC1 must be offered exactly its platoon (got ${JSON.stringify(pc1Options)})`);
  await pc1.page.evaluate((id) => assignRealMedic(id, '', ''), M2);
  assert(SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === M2 && m.assigned_by === PC1), `${rel}: PC1 must assign its own platoon's medic`);
  assert(!(await pc1.page.evaluate(() => canManagePlatoonRoster())), `${rel}: a PC must not be offered the roster panel`);
  await pc1.page.evaluate(() => startRoleDashboard('pc'));
  assert(await pc1.page.locator('#platoon-roster-panel').count() === 0, `${rel}: no roster panel on the PC dashboard`);
  const pcBody = await pc1.page.locator('#role-dashboard-body').innerText();
  const myRow = pcBody.split('\n').findIndex((l) => l.includes('המחלקה שלי'));
  assert(myRow >= 0 && pcBody.split('\n').slice(myRow, myRow + 3).join(' ').includes('מחלקה א'), `${rel}: the PC dashboard must name its platoon`);

  const errors = [...pc2.errors, ...rpc1.errors, ...cc.errors, ...pc1.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: platoon security scope browser test passed`);
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
