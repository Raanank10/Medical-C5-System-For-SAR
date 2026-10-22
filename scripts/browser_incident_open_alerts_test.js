// Real-browser test of D10 (docs/GAP_CLOSURE_PLAN.md, database/064, V2.99.48): there are no
// draft incidents any more. A medic opens an official incident at once; before that the phone
// lists the open incidents of the medic's company and offers to join one instead; once opened,
// the PC and RCC of that company, the platoon's RPC (after the PC or RCC chooses the platoon) and
// CC see a banner until each of them acknowledges it; the opener may cancel the incident as a
// false alarm while it has no patients, and command then sees that it was cancelled.
//
// Medic, PC, RPC, CC and logistics phones share one fake backend in this Node process (same
// harness as scripts/browser_platoon_security_test.js). The fake mirrors database/064's rules;
// the SQL itself was verified live by role impersonation (docs/RLS_AUDIT_v1.md, 064 follow-up).
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_incident_open_alerts_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const M1 = '11111111-1111-4111-8111-111111111111';
const PC1 = '22222222-2222-4222-8222-222222222222';
const CC = '33333333-3333-4333-8333-333333333333';
const LOGO = '44444444-4444-4444-8444-444444444444';
const M2 = '55555555-5555-4555-8555-555555555555';
const RPC1 = '66666666-6666-4666-8666-666666666666';
const CA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const A1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
const A2 = 'a2a2a2a2-0000-4000-8000-0000000000a2';
const B1 = 'b1b1b1b1-0000-4000-8000-0000000000b1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'm1@test': { id: M1, role: 'medic', display_name: 'חובש א' },
  'm2@test': { id: M2, role: 'medic', display_name: 'חובש ב' },
  'pc1@test': { id: PC1, role: 'pc', display_name: 'חוג"ד א' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ רפואה' },
  'rpc1@test': { id: RPC1, role: 'rpc', display_name: 'מ"מ א1' },
  'logo@test': { id: LOGO, role: 'logistics_officer', display_name: 'קל"ג' },
};
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
const SEES_ALL = ['cc', 'chamal', 'admin', 'physician', 'paramedic'];
const UNIT_MANAGERS = ['cc', 'chamal', 'admin', 'physician'];

function newServer() {
  return {
    incidents: [],
    members: [],
    patients: {}, // incident id -> count
    acks: [],
    rpcLog: [],
    platoons: [
      { id: A1, company_id: CA, name: 'A1', is_active: true },
      { id: A2, company_id: CA, name: 'A2', is_active: true },
      { id: B1, company_id: CB, name: 'B1', is_active: true },
    ],
    units: { [M1]: { company_id: CA }, [M2]: { company_id: CA }, [PC1]: { company_id: CA }, [RPC1]: { platoon_id: A1 } },
  };
}
function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const unit = (id) => server.units[id] || {};
  const companyOf = (id) => unit(id).company_id || server.platoons.find((p) => p.id === unit(id).platoon_id)?.company_id || null;
  const member = (incId) => server.members.some((m) => m.incident_id === incId && m.profile_id === u.id);
  const myCompany = companyOf(u.id);
  const myPlatoon = unit(u.id).platoon_id || null;
  const canSee = (inc) => SEES_ALL.includes(u.role) || member(inc.id)
    || (['pc', 'rcc'].includes(u.role) && !!myCompany && inc.company_id === myCompany)
    || (u.role === 'rpc' && !!myPlatoon && inc.platoon_id === myPlatoon);
  const denied = (msg) => ({ data: null, error: { code: '42501', message: msg } });
  const isFalseAlarmClose = (i) => i.status === 'closed' && !!i.metadata.false_alarm && i.metadata.false_alarm.at === i.closed_at;
  if (req.kind === 'rpc') {
    const p = req.params || {};
    server.rpcLog.push({ name: req.name, by: u.role, params: p });
    const inc = server.incidents.find((i) => i.id === p.p_incident_id);
    if (req.name === 'list_open_incidents') {
      return { data: clone(server.incidents.filter((i) => i.status === 'active').map((i) => ({ ...i, patient_count: server.patients[i.id] || 0, opened_by_name: userById(i.opened_by)?.display_name, is_member: member(i.id) }))), error: null };
    }
    if (req.name === 'open_incident') {
      if (u.role === 'logistics_officer') return denied('cannot open');
      const field = ['medic', 'paramedic', 'rpc'].includes(u.role);
      const row = { id: p.p_incident_id, visual_id: 'INC-' + p.p_incident_id.slice(0, 4).toUpperCase(), status: 'active', location_name: p.p_location_name, address: p.p_address, incident_type: p.p_incident_type,
        opened_by: u.id, opened_at: new Date().toISOString(), company_id: (field || ['pc', 'rcc'].includes(u.role)) ? myCompany : null, platoon_id: field ? myPlatoon : null, metadata: {}, closed_at: null };
      server.incidents.push(row);
      server.members.push({ incident_id: row.id, profile_id: u.id });
      return { data: { id: row.id, visual_id: row.visual_id, status: 'active', created: true, company_id: row.company_id, platoon_id: row.platoon_id }, error: null };
    }
    if (req.name === 'list_unit_open_incidents') {
      if (!myCompany) return { data: [], error: null };
      return { data: clone(server.incidents.filter((i) => i.status === 'active' && i.company_id === myCompany).map((i) => ({ id: i.id, visual_id: i.visual_id, location_name: i.location_name, address: i.address, incident_type: i.incident_type, opened_at: i.opened_at, opened_by_name: userById(i.opened_by)?.display_name, patient_count: server.patients[i.id] || 0, is_member: member(i.id) }))), error: null };
    }
    if (req.name === 'join_incident') {
      if (!inc || inc.status !== 'active') return denied('not open');
      const ownCompany = ['medic', 'paramedic'].includes(u.role) && !!inc.company_id && inc.company_id === myCompany;
      if (['pc', 'rpc', 'rcc', 'medic', 'paramedic'].includes(u.role) && !canSee(inc) && !ownCompany) return denied('assignment required');
      if (!member(inc.id)) server.members.push({ incident_id: inc.id, profile_id: u.id });
      return { data: { id: inc.id, status: inc.status }, error: null };
    }
    if (req.name === 'list_incident_open_alerts') {
      if (!['cc', 'chamal', 'admin', 'pc', 'rcc', 'rpc'].includes(u.role)) return { data: [], error: null };
      const rows = server.incidents.filter((i) => ['medic', 'paramedic'].includes(userById(i.opened_by)?.role)
        && (i.status === 'active' || isFalseAlarmClose(i))
        && !server.acks.some((a) => a.incident_id === i.id && a.profile_id === u.id)
        && (['cc', 'chamal', 'admin'].includes(u.role) || (['pc', 'rcc'].includes(u.role) && !!myCompany && i.company_id === myCompany) || (u.role === 'rpc' && !!myPlatoon && i.platoon_id === myPlatoon)));
      return { data: clone(rows.map((i) => ({ id: i.id, visual_id: i.visual_id, location_name: i.location_name, address: i.address, status: i.status, opened_at: i.opened_at,
        opened_by_name: userById(i.opened_by)?.display_name, opened_by_role: userById(i.opened_by)?.role, company_id: i.company_id, platoon_id: i.platoon_id,
        patient_count: server.patients[i.id] || 0, no_unit: !i.company_id, needs_platoon: !!i.company_id && !i.platoon_id, cancelled: isFalseAlarmClose(i), cancel_reason: i.metadata.false_alarm?.reason || null }))), error: null };
    }
    if (req.name === 'acknowledge_incident_opened') {
      if (!['cc', 'chamal', 'admin', 'pc', 'rcc', 'rpc'].includes(u.role)) return denied('not informed');
      server.acks.push({ incident_id: p.p_incident_id, profile_id: u.id });
      return { data: { id: p.p_incident_id, acknowledged: true }, error: null };
    }
    if (req.name === 'set_incident_platoon') {
      if (!(UNIT_MANAGERS.includes(u.role) || (['pc', 'rcc'].includes(u.role) && !!inc.company_id && inc.company_id === myCompany))) return denied('only the PC or RCC of the company');
      if (!server.platoons.some((pl) => pl.id === p.p_platoon_id && pl.company_id === inc.company_id)) return { data: null, error: { code: '22023', message: 'not a platoon of the company' } };
      inc.platoon_id = p.p_platoon_id;
      return { data: { incident_id: inc.id, platoon_id: inc.platoon_id }, error: null };
    }
    if (req.name === 'cancel_incident_false_alarm') {
      if (!inc) return { data: null, error: { message: 'not found' } };
      if (inc.opened_by !== u.id) return denied('only the opener');
      if (inc.status !== 'active') return denied('not active');
      if (server.patients[inc.id]) return denied('has patients');
      const at = new Date().toISOString();
      inc.status = 'closed'; inc.closed_at = at; inc.metadata = { ...inc.metadata, false_alarm: { reason: p.p_reason, at, by: u.id } };
      return { data: { id: inc.id, status: 'closed', changed: true }, error: null };
    }
    if (req.name === 'get_incident_command_state') return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null };
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).filter((x) => x.id === u.id).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true, company_id: unit(x.id).company_id || null, platoon_id: unit(x.id).platoon_id || null }));
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'platoons') return { data: clone(server.platoons), error: null };
  if (req.table === 'incidents') {
    const rows = server.incidents.filter((i) => canSee(i) && Object.entries(req.eq || {}).every(([c, v]) => i[c] === v));
    const data = req.single ? (rows[0] || null) : rows;
    return { data: clone(data), error: null };
  }
  return { data: req.single ? null : [], error: null };
}

const FAKE_SUPABASE = `
(function(){
  const USERS=${JSON.stringify(USERS)};
  const session=()=>{ try{ return JSON.parse(sessionStorage.getItem('__fake_session')); }catch(e){ return null; } };
  const userId=()=>session()?.user?.id||null;
  function builder(table){
    const q={kind:'from',table,op:'select',eq:{},single:false};
    const b={};
    b.select=()=>b; b.eq=(c,v)=>{ q.eq[c]=v; return b; };
    b.single=()=>{ q.single=true; return b; }; b.maybeSingle=b.single;
    ['in','not','order','limit','update','upsert','gte','gt','lt','lte','neq','is','range','insert','delete'].forEach(m=>{ b[m]=()=>b; });
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
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'synthetic false alarm' : undefined));
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
async function openIncidentFromPicker(page, location) {
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  await page.fill('#incident-open-location', location);
  await page.click('#incident-open-btn');
}
const bannerText = (page) => page.evaluate(async () => { await pollIncidentOpenAlerts(); const b = document.getElementById('incident-open-alert-banner'); return b.style.display === 'none' ? '' : b.innerText; });
let SERVER = null;

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));
  const opens = () => SERVER.rpcLog.filter((r) => r.name === 'open_incident').length;

  // 1. Medic 1 (company A) opens an incident: the company has none open, so no warning; it is
  // active at once, in company A, with no platoon yet.
  const m1 = await openPhone(context, file);
  await login(m1.page, 'm1@test');
  await openIncidentFromPicker(m1.page, 'Synthetic Site North');
  await m1.page.waitForSelector('#screen-enroute.active', { timeout: 5000 });
  const incA = SERVER.incidents[0];
  assert(incA && incA.status === 'active' && incA.company_id === CA && !incA.platoon_id, `${rel}: medic's incident must be active in company A without a platoon (got ${JSON.stringify(incA)})`);
  assert(SERVER.rpcLog.some((r) => r.name === 'list_unit_open_incidents' && r.by === 'medic'), `${rel}: the medic's phone must check the company's open incidents before opening`);
  assert(await m1.page.locator('#incident-strip-false-alarm-btn').isVisible(), `${rel}: the opener of an empty incident must be offered the false-alarm cancel`);

  // 2. Medic 2 (same company) tries to open another: the phone lists incident A and offers to
  // join it instead; nothing is opened. Joining enters incident A.
  const m2 = await openPhone(context, file);
  await login(m2.page, 'm2@test');
  await openIncidentFromPicker(m2.page, 'Synthetic Site North (again)');
  await m2.page.waitForSelector('#incident-open-dupes', { state: 'visible', timeout: 5000 });
  assert((await m2.page.textContent('#incident-open-dupes')).includes('Synthetic Site North'), `${rel}: the warning must list the company's open incident`);
  assert(opens() === 1, `${rel}: the warning must come before any open_incident call (got ${opens()})`);
  await m2.page.click('#incident-open-dupes button:has-text("הצטרף לאירוע זה")');
  await m2.page.waitForFunction((id) => activeIncident?.id === id, incA.id, { timeout: 5000 });
  assert(SERVER.members.some((m) => m.incident_id === incA.id && m.profile_id === M2), `${rel}: joining instead must make medic 2 a member of incident A`);
  assert(opens() === 1, `${rel}: joining instead must not open a second incident`);
  assert(!(await m2.page.locator('#incident-strip-false-alarm-btn').isVisible()), `${rel}: only the opener is offered the false-alarm cancel`);

  // 3. Medic 2 goes back and opens a different incident: second press = "open anyway".
  await m2.page.evaluate(() => openIncidentPicker());
  await openIncidentFromPicker(m2.page, 'Synthetic Site South');
  await m2.page.waitForSelector('#incident-open-dupes', { state: 'visible', timeout: 5000 });
  assert((await m2.page.textContent('#incident-open-btn')).includes('בכל זאת'), `${rel}: the open button must turn into "open anyway"`);
  await m2.page.click('#incident-open-btn');
  await m2.page.waitForSelector('#screen-enroute.active', { timeout: 5000 });
  assert(opens() === 2, `${rel}: "open anyway" must open the second incident (got ${opens()})`);
  const incB = SERVER.incidents[1];

  // 4. PC 1 (company A): both incidents on the pulsing banner, flagged as needing a platoon;
  // only company A's platoons are offered. The RPC of platoon A1 sees nothing yet.
  const pc1 = await openPhone(context, file);
  await login(pc1.page, 'pc1@test');
  const pcBanner = await bannerText(pc1.page);
  assert(pcBanner.includes('Synthetic Site North') && pcBanner.includes('Synthetic Site South'), `${rel}: PC must see both opened incidents (got ${pcBanner})`);
  assert(pcBanner.includes('טרם נקבעה מחלקה'), `${rel}: PC banner must say the platoon is not set`);
  assert(await pc1.page.evaluate(() => document.getElementById('incident-open-alert-banner').classList.contains('pulse')), `${rel}: the banner must pulse until acknowledged`);
  const offered = await pc1.page.evaluate((id) => [...document.querySelectorAll(`#open-alert-platoon-${id} option`)].map((o) => o.value).filter(Boolean), incA.id);
  assert(offered.length === 2 && offered.includes(A1) && offered.includes(A2) && !offered.includes(B1), `${rel}: PC must be offered exactly company A's platoons (got ${JSON.stringify(offered)})`);

  const rpc1 = await openPhone(context, file);
  await login(rpc1.page, 'rpc1@test');
  assert((await bannerText(rpc1.page)) === '', `${rel}: the RPC must not be informed before the platoon is chosen`);

  // 5. PC chooses platoon A1 for incident A: the RPC of A1 is now informed of A (not of B).
  await pc1.page.selectOption(`#open-alert-platoon-${incA.id}`, A1);
  await pc1.page.click(`.open-alert-row[data-incident-id="${incA.id}"] button:has-text("שבץ מחלקה")`);
  await pc1.page.waitForTimeout(300);
  assert(incA.platoon_id === A1, `${rel}: set_incident_platoon must set platoon A1 (got ${incA.platoon_id})`);
  const rpcBanner = await bannerText(rpc1.page);
  assert(rpcBanner.includes('Synthetic Site North') && !rpcBanner.includes('Synthetic Site South'), `${rel}: the RPC of A1 must now see incident A only (got ${rpcBanner})`);
  assert(!rpcBanner.includes('שבץ מחלקה'), `${rel}: an RPC is not offered the platoon choice`);

  // 6. Acknowledgment is per person: the PC acknowledges A; it stays on the RPC's and CC's banner.
  await pc1.page.click(`.open-alert-row[data-incident-id="${incA.id}"] button:has-text("ראיתי")`);
  await pc1.page.waitForTimeout(300);
  const pcAfter = await bannerText(pc1.page);
  assert(!pcAfter.includes('Synthetic Site North') && pcAfter.includes('Synthetic Site South'), `${rel}: the PC's acknowledgment must hide A for the PC only (got ${pcAfter})`);
  assert((await bannerText(rpc1.page)).includes('Synthetic Site North'), `${rel}: the RPC still sees A until it acknowledges`);
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  const ccBanner = await bannerText(cc.page);
  assert(ccBanner.includes('Synthetic Site North') && ccBanner.includes('Synthetic Site South'), `${rel}: CC must see both incidents (got ${ccBanner})`);

  // 7. Medic 2 cancels incident B (empty) as a false alarm; the PC is told it was cancelled.
  await m2.page.click('#incident-strip-false-alarm-btn');
  await m2.page.waitForFunction(() => activeIncident?.status === 'closed', null, { timeout: 5000 });
  assert(incB.status === 'closed' && incB.metadata.false_alarm?.reason === 'synthetic false alarm', `${rel}: the cancel must close B with the reason (got ${JSON.stringify(incB)})`);
  assert((await m2.page.textContent('#incident-context-strip')).includes('אזעקת שווא'), `${rel}: the opener's strip must say false alarm`);
  const pcCancelled = await bannerText(pc1.page);
  assert(pcCancelled.includes('בוטל') && pcCancelled.includes('synthetic false alarm'), `${rel}: the PC must see that B was cancelled and why (got ${pcCancelled})`);

  // 8. Incident A gets a patient: medic 1 is no longer offered the cancel (the server refuses too).
  SERVER.patients[incA.id] = 1;
  await m1.page.evaluate(() => refreshIncidentContext());
  assert(!(await m1.page.locator('#incident-strip-false-alarm-btn').isVisible()), `${rel}: no false-alarm cancel once the incident has a patient`);

  // 9. Logistics is never informed and never asks.
  const logo = await openPhone(context, file);
  await login(logo.page, 'logo@test');
  assert((await bannerText(logo.page)) === '', `${rel}: logistics gets no open-incident banner`);
  assert(!SERVER.rpcLog.some((r) => r.name === 'list_incident_open_alerts' && r.by === 'logistics_officer'), `${rel}: logistics must not call list_incident_open_alerts`);

  const errors = [...m1.errors, ...m2.errors, ...pc1.errors, ...rpc1.errors, ...cc.errors, ...logo.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: incident open alerts (D10) browser test passed`);
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
