// Real-browser test of the pre-evacuation report (V2.99.36, database/049-050): casualties
// evacuated before the medical force arrived. Two medic phones, a PC and a CC (four browser
// contexts, so four separate devices) share one fake backend in this Node process, the same harness as
// scripts/browser_evacuation_tracking_test.js. The fake mirrors what the real server does:
// - sync-log role gating: SITE_PRE_EVACUATION_REPORTED from medic/paramedic/physician/pc/cc
// - project_pre_evacuation() (database/050): the first medical report to sync creates the row,
//   after that only pc/cc/admin replace it (newest local_timestamp wins); anyone else's version is
//   kept in the event log and logged to conflict_log as PRE_EVACUATION_REPORT_LOCKED.
// It proves client behavior only; database/050 itself must be exercised against real Postgres.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_pre_evacuation_test.js
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
const MEDIC2 = '44444444-4444-4444-8444-444444444444';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'pc@test': { id: PC, role: 'pc', display_name: 'חוג"ד בדיקה' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'medic@test': { id: MEDIC, role: 'medic', display_name: 'חובש ראשון' },
  'medic2@test': { id: MEDIC2, role: 'medic', display_name: 'חובש שני' },
};
const BLANKET = ['cc', 'chamal', 'admin', 'rpc', 'rcc', 'physician'];
const COMMAND = ['pc', 'cc', 'chamal', 'admin', 'physician'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const PRE = 'SITE_PRE_EVACUATION_REPORTED';
const ALLOWED = { pc: [PRE], cc: [PRE], medic: [PRE], paramedic: [PRE], physician: [PRE] };
const EVACUATORS = ['mda', 'united_hatzalah', 'yedidim', 'fire', 'police', 'idf', 'civilian', 'self', 'other'];

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [{ id: INC1, visual_id: 'INC-TEST-1', status: 'active', location_name: 'מוקד בדיקה 1', address: null, incident_type: null, metadata: {} }],
    members: [PC, MEDIC, MEDIC2].map((id) => ({ incident_id: INC1, profile_id: id, role_at_incident: userById(id).role, assigned_by: null, created_at: now })),
    patients: [],
    events: [],
    incident_pre_evacuations: [],
    conflict_log: [],
    rejected: [],
  };
}

// Port of project_pre_evacuation() (database/050).
function projectPreEvacuation(server, evt, actorId) {
  const u = userById(actorId);
  const groups = [];
  for (const g of (Array.isArray(evt.payload_json?.groups) ? evt.payload_json.groups : []).slice(0, 50)) {
    if (!g || typeof g !== 'object' || !/^[0-9]{1,4}$/.test(String(g.count ?? ''))) continue;
    const count = Number(g.count);
    if (count < 1 || !['light', 'moderate', 'severe'].includes(g.condition)) continue;
    groups.push({ count, condition: g.condition, evacuated_by: EVACUATORS.includes(g.evacuated_by) ? g.evacuated_by : 'other', destination: (String(g.destination || '').trim().slice(0, 200)) || null });
  }
  const note = String(evt.payload_json?.note || '').trim().slice(0, 500) || null;
  const row = server.incident_pre_evacuations.find((r) => r.incident_id === evt.incident_id);
  if (!row && ['medic', 'paramedic', 'physician', 'pc', 'cc', 'admin'].includes(u.role)) {
    server.incident_pre_evacuations.push({ incident_id: evt.incident_id, groups, note, reported_by: actorId, reported_by_name: u.display_name, reported_by_role: u.role, reported_at: evt.local_timestamp, updated_by: actorId, updated_by_name: u.display_name, updated_by_role: u.role, updated_at: evt.local_timestamp });
    return;
  }
  if (row && ['pc', 'cc', 'admin'].includes(u.role)) {
    if (Date.parse(row.updated_at) <= Date.parse(evt.local_timestamp)) Object.assign(row, { groups, note, updated_by: actorId, updated_by_name: u.display_name, updated_by_role: u.role, updated_at: evt.local_timestamp });
    return;
  }
  if (row) {
    server.conflict_log.push({ incident_id: evt.incident_id, conflict_type: 'PRE_EVACUATION_REPORT_LOCKED', resolved_at: null, created_at: new Date().toISOString(),
      payload_json: { rejected_role: u.role, rejected_name: u.display_name, owner_id: row.reported_by, groups, note } });
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
    if (e.type === PRE) projectPreEvacuation(server, evt, userId);
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
  const visible = (rows) => rows.filter((r) => server.incidents.some((i) => i.id === r.incident_id && canSee(i))).filter(match);
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
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') return { data: null, error: null };
    let vis = server.members.filter((r) => r.profile_id === u.id || ['pc', 'cc'].includes(u.role)).filter(match);
    if (req.limit) vis = vis.slice(0, req.limit);
    return { data: clone(req.single ? (vis[0] || null) : vis), error: null };
  }
  if (req.table === 'incident_pre_evacuations' || req.table === 'patients') {
    const rows = visible(server[req.table]);
    return { data: clone(req.single ? (rows[0] || null) : rows), error: null };
  }
  if (req.table === 'conflict_log') {
    // conflict_read_command: command roles only.
    const rows = COMMAND.includes(u.role) ? visible(server.conflict_log).filter((r) => r.resolved_at == null) : [];
    return { data: clone(rows), error: null };
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

async function pullPre(page) {
  await page.evaluate(() => pullPreEvacuation(SITE_TO_INCIDENT_ID.SITE_A));
  await page.waitForTimeout(300);
}
async function addRow(page, count, condition, evacuator, destination) {
  await page.fill('#preevac-count', String(count));
  await page.click(`#preevac-condition button:has-text("${condition}")`);
  await page.click(`#preevac-evacuator button:has-text("${evacuator}")`);
  await page.fill('#preevac-destination', destination);
  await page.click('#preevac-sheet-modal button:has-text("+ הוסף שורה")');
}
const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ');

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  SERVER = newServer();
  // One browser context per phone: tabs in one context would share localStorage, and the point
  // here is separate devices that only meet through the server.
  const contexts = [];
  const phone = async () => {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));
    contexts.push(context);
    return openPhone(context, file);
  };

  // First medic on site: enters two groups from the en-route screen and sends the report.
  const m1 = await phone();
  await login(m1.page, 'medic@test');
  await enter(m1.page);
  await m1.page.evaluate(() => goTo('enroute'));
  await m1.page.click('#screen-enroute [data-preevac-open]');
  await m1.page.waitForSelector('#preevac-sheet-modal:not(.hidden)');
  await addRow(m1.page, 3, 'קל', 'מד״א', 'שיבא');
  await addRow(m1.page, 1, 'קשה', 'אזרחים', 'איכילוב');
  await m1.page.fill('#preevac-note', 'לפי דיווח שוטר בזירה');
  await m1.page.click('#preevac-sheet-modal button:has-text("שלח דיווח ונעל")');
  let enroute = await text(m1.page, '#screen-enroute [data-preevac-summary]');
  assert(enroute.includes('סה״כ 4') && enroute.includes('פונו ע״י מד״א') && enroute.includes('לאן: שיבא') && enroute.includes('1 קשה'), `${rel}: en-route summary must show who evacuated, where and condition (got ${enroute})`);
  assert(enroute.includes('ממתין לסנכרון'), `${rel}: an unsynced report must say so`);
  assert(!(await m1.page.evaluate(() => canWritePreEvac())), `${rel}: the first medic may not edit after sending`);
  // A second medic enters their own report before the first one has synced (both offline).
  const m2 = await phone();
  await login(m2.page, 'medic2@test');
  await enter(m2.page);
  assert(await m2.page.evaluate(() => canWritePreEvac()), `${rel}: with nothing on the server yet, the second medic's device offers a first report`);
  await m2.page.evaluate(() => { openPreEvacuationSheet(); });
  await addRow(m2.page, 5, 'בינוני', 'כב״א', 'וולפסון');
  await m2.page.click('#preevac-sheet-modal button:has-text("שלח דיווח ונעל")');
  // The first medic syncs first, so theirs is the report.
  await syncAll(m1.page);
  const row = SERVER.incident_pre_evacuations[0];
  assert(row && row.reported_by === MEDIC && row.groups.length === 2 && row.groups[0].evacuated_by === 'mda' && row.groups[0].destination === 'שיבא' && row.groups[1].condition === 'severe', `${rel}: report must reach the server as groups (got ${JSON.stringify(row)})`);
  assert(row.note === 'לפי דיווח שוטר בזירה', `${rel}: note must reach the server`);
  await pullPre(m1.page);
  enroute = await text(m1.page, '#screen-enroute [data-preevac-summary]');
  assert(enroute.includes('הוזן ע״י את/ה') && !enroute.includes('ממתין לסנכרון'), `${rel}: after sync the first medic sees it is theirs and synced (got ${enroute})`);
  await m1.page.evaluate(() => goTo('dashboard'));
  await m1.page.waitForTimeout(150);
  assert(await m1.page.textContent('#count-red') === '1' && await m1.page.textContent('#count-green') === '3', `${rel}: dashboard counters must include the pre-evacuated casualties`);

  // The first medic cannot change it again, even by calling the submit directly.
  const before = SERVER.events.length;
  await m1.page.evaluate(() => { preEvacSheet.groups = [{ count: 9, condition: 'light', evacuatedBy: 'self', destination: '' }]; submitPreEvacuationReport(); });
  await syncAll(m1.page);
  assert(SERVER.events.length === before, `${rel}: a locked report must not send a new event from the first medic`);

  // Then the second medic syncs: kept in the log, not applied.
  await syncAll(m2.page);
  assert(SERVER.incident_pre_evacuations[0].reported_by === MEDIC && SERVER.incident_pre_evacuations[0].groups.length === 2, `${rel}: the second medic's report must not replace the first`);
  assert(SERVER.events.filter((e) => e.type === 'SITE_PRE_EVACUATION_REPORTED' && e.actor_id === MEDIC2).length === 1, `${rel}: the second medic's version stays in the event log`);
  assert(SERVER.conflict_log.length === 1, `${rel}: the rejected version must be logged for command`);
  await pullPre(m2.page);
  assert(await m2.page.evaluate(() => siteData.initialEvacuation.rejectedNotice === true && siteData.initialEvacuation.groups.length === 2), `${rel}: the second medic's device must switch to the server report and flag the rejection`);
  assert(!(await m2.page.evaluate(() => canWritePreEvac())), `${rel}: the second medic may not edit`);
  await m2.page.evaluate(() => openPreEvacuationSheet());
  const m2sheet = await text(m2.page, '#preevac-sheet-modal');
  assert(!m2sheet.includes('שלח דיווח') && !m2sheet.includes('שמור עדכון') && m2sheet.includes('חובש ראשון') && m2sheet.includes('הדיווח נעול'), `${rel}: the second medic sees a read-only report naming the first reporter (got ${m2sheet})`);

  // PC: sees the report and the rejected version, and may change it.
  const pc = await phone();
  await login(pc.page, 'pc@test');
  await enter(pc.page);
  await pullPre(pc.page);
  await pc.page.evaluate(() => goTo('commander'));
  await pc.page.waitForTimeout(250);
  let cmd = await text(pc.page, '#cmd-priority-board');
  assert(cmd.includes('פונו לפני הגעת כוח רפואי') && cmd.includes('פונו ע״י אזרחים') && cmd.includes('לאן: איכילוב') && cmd.includes('חובש ראשון'), `${rel}: PC command board must show who evacuated, where, condition and who reported (got ${cmd.slice(0, 500)})`);
  assert(cmd.includes('1 דיווחים נוספים נדחו'), `${rel}: PC must see that a version was rejected`);
  assert(await pc.page.evaluate(() => canWritePreEvac()), `${rel}: PC may change the report`);
  await pc.page.click('#cmd-priority-board button:has-text("עדכן דיווח")');
  await pc.page.waitForSelector('#preevac-sheet-modal:not(.hidden)');
  assert((await text(pc.page, '#preevac-sheet-modal')).includes('וולפסון'), `${rel}: PC sheet must list the rejected version's content`);
  await pc.page.locator('#preevac-rows button[aria-label="הסר שורה"]').first().click();
  await addRow(pc.page, 2, 'בינוני', 'איחוד הצלה', 'בילינסון');
  await pc.page.click('#preevac-sheet-modal button:has-text("שמור עדכון")');
  await syncAll(pc.page);
  const updated = SERVER.incident_pre_evacuations[0];
  assert(updated.updated_by === PC && updated.reported_by === MEDIC, `${rel}: PC update keeps the first reporter and records the editor`);
  assert(updated.groups.length === 2 && updated.groups.some((g) => g.evacuated_by === 'united_hatzalah' && g.destination === 'בילינסון' && g.count === 2) && !updated.groups.some((g) => g.destination === 'שיבא'), `${rel}: PC's version must replace the groups (got ${JSON.stringify(updated.groups)})`);

  // CC on another device sees PC's version, and may also change it.
  const cc = await phone();
  await login(cc.page, 'cc@test');
  await enter(cc.page);
  await pullPre(cc.page);
  await cc.page.evaluate(() => startRoleDashboard('cc'));
  await cc.page.waitForTimeout(250);
  const ccBoard = await text(cc.page, '#role-dashboard-body');
  assert(ccBoard.includes('פונו לפני הגעת כוח רפואי') && ccBoard.includes('לאן: בילינסון') && ccBoard.includes('עודכן ע״י'), `${rel}: CC dashboard must show the current report and that it was edited (got ${ccBoard.slice(0, 400)})`);
  assert(await cc.page.evaluate(() => canWritePreEvac()), `${rel}: CC may change the report`);

  // The first medic's device follows the server: PC's version, still locked.
  await pullPre(m1.page);
  assert(await m1.page.evaluate(() => siteData.initialEvacuation.groups.some((g) => g.destination === 'בילינסון') && !siteData.initialEvacuation.rejectedNotice), `${rel}: first medic must receive PC's version without a rejection notice`);
  assert(!(await m1.page.evaluate(() => canWritePreEvac())), `${rel}: first medic still may not edit`);

  // Text another user typed reaches this phone stripped of markup characters.
  SERVER.incident_pre_evacuations[0].groups[0].destination = '<img src=x onerror=window.__xss=1>שיבא';
  SERVER.incident_pre_evacuations[0].updated_at = new Date(Date.now() + 1000).toISOString();
  await pullPre(cc.page);
  await cc.page.evaluate(() => startRoleDashboard('cc'));
  await cc.page.waitForTimeout(200);
  assert(!(await cc.page.evaluate(() => window.__xss)) && !(await cc.page.evaluate(() => JSON.stringify(siteData.initialEvacuation.groups))).includes('<'), `${rel}: remote destination must arrive without markup`);

  assert(!SERVER.rejected.length, `${rel}: no event may be rejected by role (got ${JSON.stringify(SERVER.rejected)})`);
  const errors = [...m1.errors, ...m2.errors, ...pc.errors, ...cc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  for (const c of contexts) await c.close();
  console.log(`${rel}: pre-evacuation report cross-device browser test passed`);
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
