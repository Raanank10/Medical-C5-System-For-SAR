// Real-browser test of the offline cold start (V2.99.45, docs/GAP_CLOSURE_PLAN.md WP-10, sw.js).
// Serves the repo over http://localhost (a service worker never registers on file://), lets
// sw.js cache the page and the pinned supabase-js, then cuts the network and reloads:
// - local demo mode: the PIN gate opens and a patient recorded before the reload is still there;
// - signed in: after the PIN, the session and the active incident come back with no network, and
//   an event recorded offline waits in the outbox and is sent once the network returns.
// Also checks the worker never caches a Supabase API call and that file:// does not register one.
// The fake backend is the same harness as scripts/browser_rescue_site_authority_test.js.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_offline_cold_start_test.js
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const RPC = '11111111-1111-4111-8111-111111111111';
const RCC = '22222222-2222-4222-8222-222222222222';
const PC = '33333333-3333-4333-8333-333333333333';
const MEDIC = '44444444-4444-4444-8444-444444444444';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
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
    const rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: !INACTIVE.has(x.id) })).filter(match);
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

async function openPhone(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  // context.route, not page.route: it also intercepts the service worker's own fetches.
  await context.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await context.route('**/functions/v1/sync-log**', (r) => {
    if (NET_DOWN) return r.abort('internetdisconnected'); // route handlers run even when the context is offline
    if (r.request().method() !== 'POST') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) });
    const userId = (r.request().headers().authorization || '').replace('Bearer tok-', '');
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(push(SERVER, userId, r.request().postDataJSON())) });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
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
// Playwright answers routed requests and exposed bindings even with context.setOffline(true), so
// the fake backend follows this flag to behave like an unreachable server.
let NET_DOWN = false;
const INACTIVE = new Set(); // profiles the fake server reports as inactive
const setNetwork = async (context, up) => { NET_DOWN = !up; await context.setOffline(!up); };
const serve = (req) => (NET_DOWN ? { data: null, error: { message: 'Failed to fetch' } } : handle(SERVER, req));

async function waitForWorker(page) {
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker?.controller) return false;
    const names = await caches.keys();
    for (const n of names) {
      const c = await caches.open(n);
      if (await c.match('index.html') && (await c.keys()).some((r) => r.url.includes('supabase-js@'))) return true;
    }
    return false;
  }, null, { timeout: 15000, polling: 250 });
}
async function unlock(page) {
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 10000 });
  await page.fill('#pin-gate-unlock-input', PIN);
  await page.click('#pin-gate-unlock-btn');
}

async function main() {
  const httpServer = await startServer();
  const base = `http://127.0.0.1:${httpServer.address().port}/index.html`;
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : { channel: 'chromium' });
  try {
    // 0. file:// never registers a worker.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
      await page.goto('file://' + path.join(root, 'index.html'), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      assert(!(await page.evaluate(() => !!navigator.serviceWorker?.controller)), 'file:// must not be controlled by a service worker');
      await context.close();
    }

    // 1. Local demo mode: record a patient, go offline, reload.
    {
      SERVER = newServer();
      NET_DOWN = false;
      const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
      await context.exposeBinding('__fakeServer', (_source, req) => serve(req));
      const { page, errors } = await openPhone(context, base);
      await page.waitForSelector('#screen-login.active', { timeout: 5000 });
      await page.evaluate(() => { patients.push({ id: 'P-OFFLINE-1', visualId: 'P-OFFLINE-1', triage: 'red', siteId: 'SITE_A', events: [], vitals: { ...VITALS_BASELINE } }); saveDemoState(); });
      await page.waitForTimeout(300);
      await waitForWorker(page);
      await setNetwork(context, false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await unlock(page);
      await page.waitForSelector('#screen-login.active', { timeout: 10000 });
      await page.evaluate(() => continueDemo()); // the launcher's "continue saved demo"
      await page.waitForTimeout(500);
      const ok = await page.evaluate(() => ({ lib: typeof window.supabase?.createClient, has: patients.some((p) => p.visualId === 'P-OFFLINE-1'), offline: !navigator.onLine }));
      assert(ok.offline, 'the page must be offline for this check');
      assert(ok.lib === 'function', `the cached supabase-js must load offline (got ${ok.lib})`);
      assert(ok.has, 'a patient recorded before the offline reload must still be there');
      assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      await context.close();
    }

    // 2. Signed in: session and incident come back offline; an offline event is sent on reconnect.
    {
      SERVER = newServer();
      NET_DOWN = false;
      const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
      await context.exposeBinding('__fakeServer', (_source, req) => serve(req));
      const { page, errors } = await openPhone(context, base);
      await login(page, 'rpc@test');
      await enter(page);
      await waitForWorker(page);
      await setNetwork(context, false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await unlock(page);
      await page.waitForFunction(() => !!currentUser && !!activeIncident, null, { timeout: 10000 });
      const st = await page.evaluate(() => ({ user: currentUser?.id, role: currentUser?.role, offline: !!currentUser?.offlineProfile, inc: activeIncident?.id, strip: document.querySelector('#auth-status-strip')?.innerText || '' }));
      assert(st.user === RPC && st.role === 'rpc' && st.offline, `offline, the saved profile must sign the user back in (got ${JSON.stringify(st)})`);
      assert(st.inc === INC1, `the active incident must come back offline (got ${JSON.stringify(st)})`);
      assert(st.strip.includes('לא מקוון'), `the auth strip must say the profile is the saved one (got ${st.strip})`);
      await page.evaluate(() => rescueUpdateBuildingStatus('rpc', 'unstable', 'SITE_A'));
      await page.evaluate(async () => { try { await syncPush(); } catch (e) {} });
      assert(!SERVER.events.length, 'nothing can reach the server while offline');
      assert(await page.evaluate(() => getOutbox().some((e) => !e.synced && e.type === 'BUILDING_STATUS_UPDATED')), 'the offline event must wait in the outbox');
      await setNetwork(context, true);
      await syncAll(page);
      assert(SERVER.events.some((e) => e.type === 'BUILDING_STATUS_UPDATED'), 'the offline event must be sent once the network returns');
      await page.waitForFunction(() => currentUser && !currentUser.offlineProfile, null, { timeout: 5000 });
      // The worker never stores a Supabase API call.
      const apiCached = await page.evaluate(async () => {
        for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) if (/supabase\.co|\/functions\/v1\/|\/rest\/v1\//.test(r.url)) return r.url;
        return null;
      });
      assert(!apiCached, `the worker must never cache a Supabase API call (found ${apiCached})`);
      const cacheNames = await page.evaluate(async () => caches.keys());
      const version = await page.evaluate(() => APP_VERSION);
      assert(cacheNames.length === 1 && cacheNames[0] === `c5-shell-${version}`, `one cache named after APP_VERSION (got ${cacheNames})`);
      // 3. Account made inactive meanwhile: offline it still opens; back online it is signed out.
      await setNetwork(context, false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await unlock(page);
      await page.waitForFunction(() => !!currentUser?.offlineProfile, null, { timeout: 10000 });
      INACTIVE.add(RPC);
      await setNetwork(context, true);
      await page.waitForFunction(() => !currentUser, null, { timeout: 5000 });
      INACTIVE.delete(RPC);
      // 4. After an explicit sign-out, an offline reload does not sign anyone in.
      await login(page, 'rpc@test');
      await page.waitForTimeout(300);
      assert(await page.evaluate(() => !!localStorage.getItem(LAST_PROFILE_KEY) && !localStorage.getItem(LAST_PROFILE_KEY).includes('rpc')), 'the saved profile must exist, encrypted, while signed in');
      await page.evaluate(() => signOut());
      await page.waitForTimeout(300);
      assert(await page.evaluate(() => !localStorage.getItem(LAST_PROFILE_KEY)), 'sign-out must remove the saved profile');
      await setNetwork(context, false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await unlock(page);
      await page.waitForTimeout(1000);
      assert(await page.evaluate(() => !currentUser && document.querySelector('.screen.active')?.id === 'screen-login'), 'after sign-out, an offline reload must stay on the login screen');
      assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      await context.close();
    }
    console.log('index.html: offline cold start browser test passed');
  } finally {
    await browser.close();
    httpServer.close();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
