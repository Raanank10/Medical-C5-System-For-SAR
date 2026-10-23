// Real-browser test of the clinical scope per role (V2.99.63, database/074, owner decisions
// 2026-10-23). A medic and an RPC (two browser contexts, so two devices) share one fake backend in
// this Node process, the same harness as scripts/browser_rescue_site_authority_test.js. The fake
// mirrors what the real server does after database/074:
// - patients / tourniquets RLS (app.can_read_incident_clinical): the rescue chain reads no row
// - get_rescue_patient_board(): rpc / rcc only; identity, location, access, evacuation state,
//   priority (urgent / pending / not_urgent) and the place in the evacuation order
// Checks:
// - medic: the patients this medic registered are marked "טיפלתי" and listed first; a patient from
//   another phone stays on the list unmarked; the mark survives a reload of the stored state
// - RPC: sees urgent / not urgent / not sorted, never a triage colour or a tourniquet, in the
//   server's evacuation order, and no evacuated patient in that order
// - the medical evacuation order puts deceased patients last, even with an active tourniquet
// The logistics side (bags without patients) is in scripts/browser_inventory_sync_test.js.
// It proves client behavior only; database/074 itself is exercised against real Postgres.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_role_clinical_scope_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const RPC = '11111111-1111-4111-8111-111111111111';
const MEDIC = '44444444-4444-4444-8444-444444444444';
const P_URGENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_PENDING = 'aaaaaaaa-0000-4000-8000-000000000002';
const P_NOT_URGENT = 'aaaaaaaa-0000-4000-8000-000000000003';
const P_EVACUATED = 'aaaaaaaa-0000-4000-8000-000000000004';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'rpc@test': { id: RPC, role: 'rpc', display_name: 'מ"מ חילוץ בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש בדיקה' },
};
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const now = new Date().toISOString();
  const row = (id, visual, triage, status, tq) => ({ id, incident_id: INC1, visual_id: visual, current_triage: triage, current_status: status,
    access_status: 'trapped', optional_name: null, identifying_description: `תיאור ${visual}`, location_json: { zone: 'קומה 2', label: 'קומה 2' }, version: 1, tq });
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [RPC, MEDIC].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    // Server patients, as a medic recorded them. The order medical command uses: the tourniquet
    // patient first, then by colour; the board below is what get_rescue_patient_board() returns.
    patients: [
      row(P_NOT_URGENT, 'P003-TA', 'yellow', 'identified', false),
      row(P_URGENT, 'P001-TA', 'green', 'identified', true),
      row(P_PENDING, 'P002-TA', 'pending', 'identified', false),
      row(P_EVACUATED, 'P004-TA', 'red', 'handed_over', false),
    ],
    board: [
      { id: P_URGENT, priority: 'urgent', evac_state: 'on_site', evac_order: 1 },
      { id: P_EVACUATED, priority: 'urgent', evac_state: 'evacuated', evac_order: 2 },
      { id: P_NOT_URGENT, priority: 'not_urgent', evac_state: 'on_site', evac_order: 3 },
      { id: P_PENDING, priority: 'pending', evac_state: 'on_site', evac_order: 4 },
    ],
    clinicalReadsByRescue: 0,
  };
}

function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const match = (row) => Object.entries(req.eq || {}).every(([c, v]) => row[c] === v)
    && Object.entries(req.in || {}).every(([c, v]) => v.includes(row[c]))
    && (req.notNull || []).every((c) => row[c] != null);
  const rescue = ['rpc', 'rcc'].includes(u.role);
  const member = server.members.some((m) => m.incident_id === INC1 && m.profile_id === u.id);
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') return { data: clone(server.incidents.map((i) => ({ ...i, patient_count: server.patients.length, is_member: member }))), error: null };
    if (req.name === 'join_incident') return { data: { id: p.p_incident_id }, error: null };
    if (req.name === 'get_incident_command_state') return { data: null, error: rescue ? { message: 'access denied' } : null };
    if (req.name === 'get_rescue_patient_board') {
      if (!rescue || !member) return { data: null, error: { message: 'access denied' } };
      return { data: clone(server.board.map((b) => {
        const pt = server.patients.find((x) => x.id === b.id);
        return { id: pt.id, visual_id: pt.visual_id, optional_name: pt.optional_name, identifying_description: pt.identifying_description,
          location_json: pt.location_json, access_status: pt.access_status, trap_status: 'trapped', is_trapped: true,
          evac_state: b.evac_state, priority: b.priority, evac_order: b.evac_order, updated_at: new Date().toISOString(), version: pt.version };
      })), error: null };
    }
    return { data: null, error: null };
  }
  if (req.table === 'patients' || req.table === 'tourniquets' || req.table === 'vw_patient_treatment_history' || req.table === 'watchdog_alerts') {
    // app.can_read_incident_clinical (database/074): nothing for the rescue chain.
    if (rescue) { server.clinicalReadsByRescue += 1; return { data: [], error: null }; }
    if (req.table !== 'patients') return { data: [], error: null };
    return { data: clone(server.patients.filter(match).map(({ tq, ...rest }) => rest)), error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true })).filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const vis = server.incidents.filter((i) => member && match(i));
    if (req.op === 'update') return { data: [], error: null };
    const data = req.single ? (vis[0] || null) : vis;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') return { data: null, error: null };
    let vis = server.members.filter((r) => r.profile_id === u.id).filter(match);
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

  // 1. Medic: two patients registered on this phone, the server's four from another phone.
  const medic = await phone();
  await login(medic.page, 'medic@test');
  await enter(medic.page);
  const mine = await medic.page.evaluate(() => {
    goTo('sweep');
    const ids = [];
    for (let i = 0; i < 2; i++) { startSweepCasualtyMarker(); ids.push(activeSweepPatient().id); }
    return ids;
  });
  await pullAll(medic.page);
  const list = await medic.page.evaluate(() => {
    goTo('dashboard'); renderDashboard();
    const el = document.getElementById('patient-list');
    return {
      cards: [...el.querySelectorAll('.patient-card[data-mine]')].map((c) => ({ mine: c.dataset.mine, text: c.innerText })),
      text: el.innerText,
      remote: patients.filter((p) => p.sourcedFromRemote).map((p) => ({ id: p.id, mine: isPatientHandledByMe(p) })),
    };
  });
  const firstOther = list.cards.findIndex((c) => c.mine === '0');
  assert(list.cards.filter((c) => c.mine === '1').length === 2, `${rel}: both patients the medic registered must be marked (got ${JSON.stringify(list.cards.map((c) => c.mine))})`);
  assert(firstOther === 2 && list.cards.slice(firstOther).every((c) => c.mine === '0'), `${rel}: the medic's own patients must come first (got ${JSON.stringify(list.cards.map((c) => c.mine))})`);
  assert(list.text.includes('טיפלתי (2)') && list.text.includes('פצועים נוספים באתר'), `${rel}: the list must label the medic's own patients and the others`);
  assert((list.text.match(/✓ טיפלתי/g) || []).length === 2, `${rel}: exactly the medic's own patients carry the mark`);
  assert(list.remote.length >= 3 && list.remote.every((r) => !r.mine), `${rel}: a patient from another phone is on the list but not marked (got ${JSON.stringify(list.remote)})`);
  // The mark is stored with the patients (encrypted at rest) and comes back after a reload.
  const kept = await medic.page.evaluate(async (ids) => {
    await saveDemoState();
    handledPatientIds = {};
    await loadStoredDemoState();
    return ids.every((id) => isPatientHandledByMe(patients.find((p) => p.id === id)));
  }, mine);
  assert(kept, `${rel}: the medic's marks must survive a reload of the stored state`);

  // Medical evacuation order (PC/CC tiles, the same ranking the server uses for the rescue chain):
  // deceased always last, even with an active tourniquet, below a patient not sorted yet.
  const evacOrder = await medic.page.evaluate(() => {
    const now = Date.now();
    const mk = (id, triage, status, tqMin) => ({ id, triage, patientStatus: status, vitals: {}, txHistory: [],
      tourniquet: tqMin == null ? null : { appliedAt: now - tqMin * 60000 },
      tourniquets: tqMin == null ? [] : [{ limb: 'leg', status: 'applied', appliedAt: now - tqMin * 60000 }] });
    const list = [mk('dead-tq', 'black', 'deceased', 110), mk('dead-red', 'red', 'deceased', null), mk('pending', 'pending', 'identified', null),
      mk('green', 'green', 'identified', null), mk('tq', 'yellow', 'identified', 30)];
    return { order: sortedPatientsByEvacPriority(list).map((p) => p.id), deadPriority: rescuePriorityOf(list[0]), deadRedPriority: rescuePriorityOf(list[1]) };
  });
  assert(JSON.stringify(evacOrder.order.slice(0, 3)) === JSON.stringify(['tq', 'green', 'pending']) && evacOrder.order.slice(3).every((id) => id.startsWith('dead')),
    `${rel}: deceased patients must be last in the medical evacuation order, even with a tourniquet (got ${JSON.stringify(evacOrder.order)})`);
  assert(evacOrder.deadPriority === 'not_urgent' && evacOrder.deadRedPriority === 'not_urgent', `${rel}: a deceased patient is never "urgent" for the rescue chain (got ${JSON.stringify(evacOrder)})`);

  // 2. RPC: the tactical board only - priority, never the colour or the tourniquet.
  const rpc = await phone();
  await login(rpc.page, 'rpc@test');
  await enter(rpc.page);
  await pullAll(rpc.page);
  const rp = await rpc.page.evaluate(() => patients.map((p) => ({ id: p.id, triage: p.triage, prio: p.rescuePriority, order: p.rescueEvacOrder, tq: activeTourniquets(p).length })));
  assert(rp.length === 4, `${rel}: the RPC must get the four board patients (got ${JSON.stringify(rp)})`);
  assert(rp.every((p) => !p.triage && p.tq === 0), `${rel}: no triage colour or tourniquet may reach the RPC's phone (got ${JSON.stringify(rp)})`);
  const board = await rpc.page.evaluate(() => { renderRoleDashboard('rpc'); return document.getElementById('role-dashboard-body')?.innerText || ''; });
  assert(board.includes('דחוף 2') && board.includes('לא דחוף 1') && board.includes('טרם מוין 1'), `${rel}: the RPC's counts must be by priority (got ${board.slice(0, 600)})`);
  for (const word of ['אדום', 'צהוב', 'ירוק', 'שחור', 'חסם פעיל', 'נותרו']) {
    assert(!board.includes(word), `${rel}: the RPC's dashboard must not show "${word}"`);
  }
  const order = await rpc.page.evaluate(() => {
    renderRoleDashboard('rpc');
    return [...document.querySelectorAll('#role-dashboard-body [data-rescue-priority]')].map((r) => r.innerText.split('·')[1].trim());
  });
  assert(JSON.stringify(order) === JSON.stringify(['P001-TA', 'P003-TA', 'P002-TA']), `${rel}: the RPC's evacuation order must follow the server and leave out the evacuated patient (got ${JSON.stringify(order)})`);

  const errors = [...medic.errors, ...rpc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: clinical scope per role (medic marks, rescue priority) browser test passed`);
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
