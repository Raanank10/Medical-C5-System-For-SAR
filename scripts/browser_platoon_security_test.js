// Real-browser test of the unit security scope's client side (database/045, V2.99.33; companies
// and platoons as real units since database/053, V2.99.42): CC, RCC, PC, RPC and medic phones
// share one fake backend in this Node process (same harness as
// scripts/browser_medic_assignment_test.js). The fake enforces the database/053 rules the client
// depends on: a pc / rcc reaches its own company's sites, an rpc its own platoon's, everyone also
// the sites it belongs to; no self-join elsewhere; list_open_incidents scoped; profiles readable by
// a PC only for itself and its own company; memberships written by a PC only for its own
// company's medics; create_company / create_platoon / set_profile_unit for company-level command
// only; set_incident_unit for company-level command and, inside its own company, the rcc. The SQL
// itself is tested by scripts/rls_test_053_platoons.sql (docs/RLS_AUDIT_v1.md, 053 follow-up).
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_platoon_security_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111'; // company A, platoon A1
const INC2 = '22222222-bbbb-4bbb-8bbb-222222222222'; // company B
const CC = '33333333-3333-4333-8333-333333333333';
const PC1 = '22222222-2222-4222-8222-222222222222';
const PC2 = '44444444-4444-4444-8444-444444444444';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '55555555-5555-4555-8555-555555555555';
const RPC1 = '66666666-6666-4666-8666-666666666666';
const RCC1 = '77777777-7777-4777-8777-777777777777';
const CA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const AMB = 'abababab-0000-4000-8000-0000000000ab';
const A1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
const B1 = 'b1b1b1b1-0000-4000-8000-0000000000b1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'pc1@test': { id: PC1, role: 'pc', display_name: 'חוג"ד א' },
  'pc2@test': { id: PC2, role: 'pc', display_name: 'חוג"ד ב' },
  'm1@test': { id: M1, role: 'medic', display_name: 'חובש א' },
  'm2@test': { id: M2, role: 'medic', display_name: 'חובש ב' },
  'rpc1@test': { id: RPC1, role: 'rpc', display_name: 'מ"מ א1' },
  'rcc1@test': { id: RCC1, role: 'rcc', display_name: 'מ"פ חילוץ א' },
};
const UNIT_MANAGERS = ['cc', 'chamal', 'admin', 'physician'];
const SEES_ALL = ['cc', 'chamal', 'admin', 'physician', 'paramedic'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [
      { id: INC1, visual_id: 'INC-A1', status: 'active', location_name: 'מוקד פלוגה א', address: null, incident_type: null, metadata: {}, company_id: CA, platoon_id: A1 },
      { id: INC2, visual_id: 'INC-B', status: 'active', location_name: 'מוקד פלוגה ב', address: null, incident_type: null, metadata: {}, company_id: CB, platoon_id: null },
    ],
    members: [
      { incident_id: INC1, profile_id: PC1, role_at_incident: 'pc', assigned_by: PC1, created_at: now },
      { incident_id: INC2, profile_id: PC2, role_at_incident: 'pc', assigned_by: PC2, created_at: now },
    ],
    companies: [
      { id: CA, name: 'פלוגה א', kind: 'rescue', is_active: true },
      { id: CB, name: 'פלוגה ב', kind: 'rescue', is_active: true },
      { id: AMB, name: 'אמבולנס', kind: 'ambulance', is_active: true },
    ],
    platoons: [{ id: A1, company_id: CA, name: 'A1', is_active: true }, { id: B1, company_id: CB, name: 'B1', is_active: true }],
    // M2 starts without a unit
    units: { [PC1]: { company_id: CA }, [M1]: { company_id: CA }, [RCC1]: { company_id: CA }, [RPC1]: { platoon_id: A1 }, [PC2]: { company_id: CB } },
  };
}
let seq = 0;
function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const match = (row) => Object.entries(req.eq || {}).every(([c, v]) => row[c] === v)
    && Object.entries(req.in || {}).every(([c, v]) => v.includes(row[c]))
    && (req.notNull || []).every((c) => row[c] != null);
  const unit = (id) => server.units[id] || {};
  const companyOf = (id) => unit(id).company_id || server.platoons.find((p) => p.id === unit(id).platoon_id)?.company_id || null;
  const member = (incId, uid = u.id) => server.members.some((m) => m.incident_id === incId && m.profile_id === uid);
  const myCompany = companyOf(u.id);
  const myPlatoon = unit(u.id).platoon_id || null;
  const canSee = (inc) => SEES_ALL.includes(u.role) || member(inc.id)
    || (['pc', 'rcc'].includes(u.role) && !!myCompany && inc.company_id === myCompany)
    || (u.role === 'rpc' && !!myPlatoon && inc.platoon_id === myPlatoon);
  const denied = (msg) => ({ data: null, error: { code: '42501', message: msg } });
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') {
      return { data: clone(server.incidents.filter((i) => i.status === 'active' && canSee(i)).map((i) => ({ ...i, patient_count: 0, is_member: member(i.id) }))), error: null };
    }
    if (req.name === 'join_incident') {
      if (['pc', 'rpc', 'rcc', 'medic', 'paramedic'].includes(u.role) && !canSee(server.incidents.find((i) => i.id === p.p_incident_id) || {})) return denied('assignment required');
      if (!member(p.p_incident_id)) server.members.push({ incident_id: p.p_incident_id, profile_id: u.id, role_at_incident: u.role, assigned_by: u.id, created_at: new Date().toISOString() });
      return { data: { id: p.p_incident_id }, error: null };
    }
    if (req.name === 'create_company') {
      if (!UNIT_MANAGERS.includes(u.role)) return denied('only company-level command');
      const row = { id: 'cccccccc-0000-4000-8000-' + String(++seq).padStart(12, '0'), name: p.p_name, kind: p.p_kind || 'rescue', is_active: true };
      server.companies.push(row);
      return { data: { id: row.id, name: row.name }, error: null };
    }
    if (req.name === 'create_platoon') {
      if (!UNIT_MANAGERS.includes(u.role)) return denied('only company-level command');
      if (server.companies.find((c) => c.id === p.p_company_id)?.kind !== 'rescue') return { data: null, error: { code: '22023', message: 'platoons belong to a rescue company' } };
      const row = { id: 'dddddddd-0000-4000-8000-' + String(++seq).padStart(12, '0'), company_id: p.p_company_id, name: p.p_name, is_active: true };
      server.platoons.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (req.name === 'set_profile_unit') {
      if (!UNIT_MANAGERS.includes(u.role)) return denied('only company-level command');
      const target = userById(p.p_profile_id);
      const platoonRole = ['rpc', 'medic', 'paramedic'].includes(target.role);
      if ((p.p_company_id && p.p_platoon_id) || (target.role === 'rpc' && p.p_company_id) || (!platoonRole && p.p_platoon_id)) return { data: null, error: { code: '22023', message: 'wrong unit for role' } };
      server.units[p.p_profile_id] = { company_id: p.p_company_id, platoon_id: p.p_platoon_id };
      return { data: { profile_id: p.p_profile_id }, error: null };
    }
    if (req.name === 'set_incident_unit') {
      const inc = server.incidents.find((i) => i.id === p.p_incident_id);
      const rccOk = u.role === 'rcc' && !!myCompany && p.p_company_id === myCompany && (!inc.company_id || inc.company_id === myCompany);
      if (!UNIT_MANAGERS.includes(u.role) && !rccOk) return denied('only company-level command');
      inc.company_id = p.p_company_id; inc.platoon_id = p.p_platoon_id;
      return { data: { incident_id: p.p_incident_id }, error: null };
    }
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    let rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true, company_id: unit(x.id).company_id || null, platoon_id: unit(x.id).platoon_id || null }));
    if (!UNIT_MANAGERS.includes(u.role)) rows = rows.filter((r) => r.id === u.id || (u.role === 'pc' && !!myCompany && companyOf(r.id) === myCompany));
    rows = rows.filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'companies') return { data: clone(server.companies), error: null };
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
        && !!myCompany && (member(r.incident_id) || server.incidents.find((i) => i.id === r.incident_id)?.company_id === myCompany)
        && companyOf(r.profile_id) === myCompany;
      if (!UNIT_MANAGERS.includes(u.role) && !pcOk) return denied('new row violates row-level security policy');
      const ex = server.members.find((m) => m.incident_id === r.incident_id && m.profile_id === r.profile_id);
      if (ex) Object.assign(ex, r); else server.members.push({ created_at: new Date().toISOString(), ...r });
      return { data: null, error: null };
    }
    let vis = server.members.filter((r) => r.profile_id === u.id || UNIT_MANAGERS.includes(u.role) || (u.role === 'pc' && canSee(server.incidents.find((i) => i.id === r.incident_id) || {}))).filter(match);
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
  const bodyRowAfter = async (page, label) => {
    const lines = (await page.locator('#role-dashboard-body').innerText()).split('\n');
    const i = lines.findIndex((l) => l.trim() === label);
    return i < 0 ? '' : lines.slice(i, i + 3).join(' ');
  };

  // PC2 (company B) cannot reach company A's site: not listed, and a direct join is refused.
  const pc2 = await openPhone(context, file);
  await login(pc2.page, 'pc2@test');
  const listed = await pc2.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(!listed.includes(INC1), `${rel}: PC2 must not see company A's site in the picker (got ${JSON.stringify(listed)})`);
  await pc2.page.evaluate((id) => { _openIncidents.push({ id, visual_id: 'X', status: 'active', is_member: false }); return enterIncidentFromPicker(id); }, INC1);
  await pc2.page.waitForTimeout(300);
  assert(await pc2.page.evaluate((id) => activeIncident?.id !== id, INC1), `${rel}: PC2 must not enter company A's site`);
  assert(pc2.toasts.some((t) => t.includes('נדרש שיבוץ')), `${rel}: a refused join must say an assignment is needed (got ${JSON.stringify(pc2.toasts)})`);
  assert(!SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === PC2), `${rel}: no membership may be created by a refused join`);

  // RPC1 (platoon A1, no membership): reaches its platoon's site only.
  const rpc1 = await openPhone(context, file);
  await login(rpc1.page, 'rpc1@test');
  const rpcListed = await rpc1.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(rpcListed.includes(INC1) && !rpcListed.includes(INC2), `${rel}: RPC must see exactly its platoon's site (got ${JSON.stringify(rpcListed)})`);
  await rpc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await rpc1.page.waitForTimeout(300);
  await rpc1.page.evaluate(() => pullIncidentAssignmentState());
  assert(await rpc1.page.evaluate(() => realUnitName(_myPlatoonId)) === 'פלוגה א · A1', `${rel}: RPC must know its platoon and company`);

  // RCC1 (company A): its company's site only; its tiles are its own company's platoons.
  const rcc1 = await openPhone(context, file);
  await login(rcc1.page, 'rcc1@test');
  const rccListed = await rcc1.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(rccListed.includes(INC1) && !rccListed.includes(INC2), `${rel}: RCC must see exactly its company's site (got ${JSON.stringify(rccListed)})`);
  await rcc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await rcc1.page.waitForTimeout(300);
  await rcc1.page.evaluate(() => pullIncidentAssignmentState());
  const rccTiles = await rcc1.page.evaluate(() => commandPlatoons().map((p) => p.name));
  assert(rccTiles.includes('A1') && !rccTiles.includes('B1') && !rccTiles.includes('פלוגה א'), `${rel}: RCC tiles must be its own company's platoons (got ${JSON.stringify(rccTiles)})`);
  await rcc1.page.evaluate(() => startRoleDashboard('rcc'));
  assert((await bodyRowAfter(rcc1.page, 'הפלוגה שלי')).includes('פלוגה א'), `${rel}: the RCC dashboard must name its company`);

  // CC: roster panel shows the site's unit, creates a company and a platoon, places people; the
  // CC dashboard lists the real rescue companies (not the ambulance, not the demo platoons).
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await cc.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await cc.page.waitForTimeout(300);
  await cc.page.evaluate(() => startRoleDashboard('cc'));
  // V2.99.59: the roster is on the CC panel's כוחות tab.
  await cc.page.click('[data-cmd-tab="forces"]');
  await cc.page.waitForSelector('[data-roster-member]', { timeout: 5000 });
  assert(await cc.page.inputValue(`[data-incident-unit="${INC1}"]`) === `p:${A1}`, `${rel}: the roster panel must show the site's platoon`);
  await cc.page.fill('#new-company-name', 'פלוגה ג');
  await cc.page.evaluate(() => createCompanyFromPanel());
  await cc.page.waitForTimeout(300);
  assert(SERVER.companies.some((c) => c.name === 'פלוגה ג' && c.kind === 'rescue'), `${rel}: CC must be able to create a rescue company`);
  await cc.page.selectOption('#new-platoon-company', CA);
  await cc.page.fill('#new-platoon-name', 'A2');
  await cc.page.evaluate(() => createPlatoonFromPanel());
  await cc.page.waitForTimeout(300);
  const A2 = SERVER.platoons.find((p) => p.name === 'A2' && p.company_id === CA)?.id;
  assert(!!A2, `${rel}: CC must be able to create a platoon in company A`);
  await cc.page.waitForSelector(`[data-roster-member="${M2}"]`, { timeout: 5000 });
  // database/065: a medic is attached to a מ"מ's platoon (here A2); its company follows.
  await cc.page.selectOption(`[data-roster-member="${M2}"]`, `p:${A2}`);
  await cc.page.waitForTimeout(300);
  assert(SERVER.units[M2].platoon_id === A2 && !SERVER.units[M2].company_id, `${rel}: CC must attach a medic to a platoon`);
  await cc.page.selectOption(`[data-roster-member="${RPC1}"]`, A2);
  await cc.page.waitForTimeout(300);
  assert(SERVER.units[RPC1].platoon_id === A2 && !SERVER.units[RPC1].company_id, `${rel}: CC must place a מ"מ in a platoon`);
  const ccTiles = await cc.page.evaluate(() => commandPlatoons().map((p) => p.name));
  assert(ccTiles.includes('פלוגה א') && ccTiles.includes('פלוגה ב') && ccTiles.includes('פלוגה ג') && !ccTiles.includes('אמבולנס') && !ccTiles.includes('מחלקה רפואית א'),
    `${rel}: CC tiles must be the real rescue companies (got ${JSON.stringify(ccTiles)})`);
  await cc.page.click('[data-cmd-tab="overview"]');
  assert((await cc.page.locator('#role-dashboard-body').innerText()).includes('פלוגות פעילות'), `${rel}: CC dashboard must count companies`);
  const ccOptions = await cc.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.role); });
  assert(ccOptions.includes('pc'), `${rel}: CC must be offered PC accounts to assign`);
  await cc.page.evaluate((id) => assignRealMedic(id, '', ''), PC2);
  assert(SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === PC2 && m.assigned_by === CC), `${rel}: CC must be able to assign a PC to a site`);

  // RPC1 now leads A2: the A1 site is gone from its picker.
  const rpcAfter = await rpc1.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(!rpcAfter.includes(INC1), `${rel}: after moving to A2 the מ"מ must no longer see A1's site (got ${JSON.stringify(rpcAfter)})`);

  // PC1: offered exactly its company's medics; cannot change the roster; names its company.
  const pc1 = await openPhone(context, file);
  await login(pc1.page, 'pc1@test');
  await pc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await pc1.page.waitForTimeout(300);
  const pc1Options = await pc1.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.id); });
  assert(pc1Options.length === 2 && pc1Options.includes(M1) && pc1Options.includes(M2), `${rel}: PC1 must be offered exactly the medics under its guidance (got ${JSON.stringify(pc1Options)})`);
  // M2 is attached to platoon A2; INC1 is A1's site. The PC may still send it there.
  await pc1.page.evaluate((id) => assignRealMedic(id, '', ''), M2);
  assert(SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === M2 && m.assigned_by === PC1), `${rel}: PC1 must assign an A2 medic to an A1 site`);
  // PC2 (company B) is offered none of company A's medics.
  const pc2Options = await pc2.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.id); });
  assert(!pc2Options.includes(M1) && !pc2Options.includes(M2), `${rel}: PC2 must not be offered company A's medics (got ${JSON.stringify(pc2Options)})`);
  assert(!(await pc1.page.evaluate(() => canManagePlatoonRoster())), `${rel}: a PC must not be offered the roster panel`);
  await pc1.page.evaluate(() => startRoleDashboard('pc'));
  assert(await pc1.page.locator('#platoon-roster-panel').count() === 0, `${rel}: no roster panel on the PC dashboard`);
  await pc1.page.click('[data-cmd-tab="forces"]'); // V2.99.59: "הפלוגה שלי" is on the כוחות tab
  assert((await bodyRowAfter(pc1.page, 'הפלוגה שלי')).includes('פלוגה א'), `${rel}: the PC dashboard must name its company`);

  const errors = [...pc2.errors, ...rpc1.errors, ...rcc1.errors, ...cc.errors, ...pc1.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: unit security scope browser test passed`);
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
