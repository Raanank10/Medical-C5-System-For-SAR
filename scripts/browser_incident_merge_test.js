// Real-browser test of merging a duplicate incident (decision D8, database/066, sync-log v11,
// V2.99.49). Two medics opened the same event twice: incident A (the one to keep) and incident B
// (the duplicate), each with a patient P001. CC merges B into A from the incident picker:
// - only cc/chamal/admin get the "מיזוג כפילות" button (not the PC); a reason is required;
// - a medic still in B with unsent work is moved to A by the push itself (sync-log answers
//   redirected_to, and stored the events in A);
// - another medic in B is moved to A on the next incident refresh (B is closed with merged_into);
// - the renamed patient id (P001 -> P001-xxxx) is reported to the CC.
//
// CC, PC and three medic phones share one fake backend in this Node process (same harness as
// scripts/browser_incident_open_alerts_test.js). The fake mirrors merge_incident()'s and
// sync-log's contract; the SQL itself was verified live by role impersonation
// (docs/RLS_AUDIT_v1.md, 066 follow-up).
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_incident_merge_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '55555555-5555-4555-8555-555555555555';
const M3 = '66666666-6666-4666-8666-666666666666';
const PC1 = '22222222-2222-4222-8222-222222222222';
const CC = '33333333-3333-4333-8333-333333333333';
const INC_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const INC_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const P_A = 'aaaa0001-0000-4000-8000-000000000001';
const P_B = 'bbbb0001-0000-4000-8000-000000000001';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'm1@test': { id: M1, role: 'medic', display_name: 'חובש א' },
  'm2@test': { id: M2, role: 'medic', display_name: 'חובש ב' },
  'm3@test': { id: M3, role: 'medic', display_name: 'חובש ג' },
  'pc1@test': { id: PC1, role: 'pc', display_name: 'חוג"ד א' },
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ רפואה' },
};
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [
      { id: INC_A, visual_id: 'INC-AAAA', status: 'active', location_name: 'Synthetic Tower', address: null, incident_type: null, opened_by: M1, opened_at: now, metadata: {}, closed_at: null },
      { id: INC_B, visual_id: 'INC-BBBB', status: 'active', location_name: 'Synthetic Tower (dup)', address: null, incident_type: null, opened_by: M2, opened_at: now, metadata: {}, closed_at: null },
    ],
    members: [
      { incident_id: INC_A, profile_id: M1 }, { incident_id: INC_B, profile_id: M2 }, { incident_id: INC_B, profile_id: M3 },
      { incident_id: INC_A, profile_id: PC1 },
    ],
    patients: [
      { id: P_A, incident_id: INC_A, visual_id: 'P001' },
      { id: P_B, incident_id: INC_B, visual_id: 'P001' },
    ],
    events: [], // {incident_id, origin_incident_id, local_event_id, type}
    rpcLog: [],
  };
}
function mergedTarget(server, id) {
  let cur = id;
  for (let i = 0; i < 5; i++) {
    const inc = server.incidents.find((x) => x.id === cur);
    const t = inc && inc.status === 'closed' ? inc.metadata?.merged_into?.target_id : null;
    if (!t) break;
    cur = t;
  }
  return cur;
}
function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const member = (incId) => server.members.some((m) => m.incident_id === incId && m.profile_id === u.id);
  const canSee = (inc) => ['cc', 'chamal', 'admin'].includes(u.role) || member(inc.id);
  if (req.kind === 'sync') {
    // sync-log v11 push contract: follow merged_into, store there, answer redirected_to.
    const requested = req.body.incident_id;
    const effective = mergedTarget(server, requested);
    (req.body.events || []).forEach((e) => server.events.push({ incident_id: effective, requested_incident_id: requested, local_event_id: e.local_event_id, type: e.type }));
    return { accepted: (req.body.events || []).map((e) => ({ local_event_id: e.local_event_id })), duplicates: [], rejected: [], redirected_to: effective !== requested ? effective : null };
  }
  if (req.kind === 'rpc') {
    const p = req.params || {};
    server.rpcLog.push({ name: req.name, by: u.role, params: p });
    if (req.name === 'list_open_incidents') {
      return { data: clone(server.incidents.filter((i) => i.status === 'active').map((i) => ({ ...i, patient_count: server.patients.filter((x) => x.incident_id === i.id).length, opened_by_name: userById(i.opened_by)?.display_name, is_member: member(i.id) }))), error: null };
    }
    if (req.name === 'merge_incident') {
      if (!['cc', 'chamal', 'admin'].includes(u.role)) return { data: null, error: { code: '42501', message: 'only company-level command' } };
      if (!String(p.p_reason || '').trim()) return { data: null, error: { code: '22023', message: 'reason required' } };
      const src = server.incidents.find((i) => i.id === p.p_source_id);
      const tgt = server.incidents.find((i) => i.id === p.p_target_id);
      if (!src || !tgt || src.status !== 'active' || tgt.status !== 'active' || src.id === tgt.id) return { data: null, error: { code: '42501', message: 'not mergeable' } };
      const suffix = src.visual_id.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
      const renamed = [];
      server.patients.filter((x) => x.incident_id === src.id).forEach((x) => {
        if (server.patients.some((t) => t.incident_id === tgt.id && t.visual_id === x.visual_id)) { renamed.push({ patient_id: x.id, from: x.visual_id, to: `${x.visual_id}-${suffix}` }); x.visual_id = `${x.visual_id}-${suffix}`; }
      });
      let moved = 0;
      server.patients.forEach((x) => { if (x.incident_id === src.id) { x.incident_id = tgt.id; moved++; } });
      server.events.forEach((e) => { if (e.incident_id === src.id) { e.origin_incident_id = e.origin_incident_id || src.id; e.incident_id = tgt.id; } });
      server.members.filter((m) => m.incident_id === src.id).forEach((m) => { if (!server.members.some((x) => x.incident_id === tgt.id && x.profile_id === m.profile_id)) server.members.push({ incident_id: tgt.id, profile_id: m.profile_id }); });
      src.status = 'closed'; src.closed_at = new Date().toISOString();
      src.metadata = { ...src.metadata, merged_into: { target_id: tgt.id, target_visual_id: tgt.visual_id, reason: p.p_reason } };
      return { data: { source_id: src.id, target_id: tgt.id, target_visual_id: tgt.visual_id, changed: true, moved: { patients: moved }, renamed_patients: renamed, pre_evacuation_kept_on_source: false }, error: null };
    }
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    const rows = Object.values(USERS).filter((x) => x.id === u.id).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true, company_id: null, platoon_id: null }));
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'incidents') {
    const rows = server.incidents.filter((i) => canSee(i) && Object.entries(req.eq || {}).every(([c, v]) => i[c] === v));
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
    const q={kind:'from',table,op:'select',eq:{},single:false};
    const b={};
    b.select=()=>b; b.eq=(c,v)=>{ q.eq[c]=v; return b; };
    b.single=()=>{ q.single=true; return b; }; b.maybeSingle=b.single;
    ['in','not','order','limit','update','upsert','gte','gt','lt','lte','neq','is','range','insert','delete','or'].forEach(m=>{ b[m]=()=>b; });
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
  await page.route('**/functions/v1/sync-log**', async (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) });
    const userId = (r.request().headers().authorization || '').replace('Bearer tok-', '');
    const body = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(handle(SERVER, { kind: 'sync', userId, body })) });
  });
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
async function enter(page, incidentId) {
  await page.evaluate(async (id) => { await refreshOpenIncidents(); await enterIncidentFromPicker(id); }, incidentId);
  await page.waitForFunction((id) => activeIncident?.id === id, incidentId, { timeout: 5000 });
}
let SERVER = null;

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));

  // Medics 2 and 3 work in the duplicate B. Medic 2's first record reaches the server in B
  // before the merge.
  const m2 = await openPhone(context, file);
  await login(m2.page, 'm2@test');
  await enter(m2.page, INC_B);
  await m2.page.evaluate(async () => { saveLocalEvent({ type: 'QUICK_PATIENT_CREATED', patient_id: newUuid(), payload_json: { visual_id: 'P003' } }); await syncPush(); });
  const early = await m2.page.evaluate(() => getOutbox().filter((e) => e.synced).map((e) => e.local_event_id));
  assert(early.length >= 1 && early.every((lid) => SERVER.events.some((e) => e.local_event_id === lid && e.incident_id === INC_B)), `${rel}: medic 2's first record must be stored in B before the merge`);
  const m3 = await openPhone(context, file);
  await login(m3.page, 'm3@test');
  await enter(m3.page, INC_B);

  // The PC is not offered the merge.
  const pc = await openPhone(context, file);
  await login(pc.page, 'pc1@test');
  await pc.page.evaluate(async () => { openIncidentPicker(); await refreshIncidentPicker(); });
  assert(await pc.page.locator('#incident-picker-list button:has-text("מיזוג כפילות")').count() === 0, `${rel}: a PC must not be offered the merge`);

  // CC merges B into A from the picker; a reason is required.
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await cc.page.evaluate(async () => { openIncidentPicker(); await refreshIncidentPicker(); });
  await cc.page.waitForSelector('#incident-picker-list button:has-text("מיזוג כפילות")', { timeout: 5000 });
  await cc.page.evaluate((id) => toggleIncidentMergePanel(id), INC_B);
  await cc.page.waitForSelector(`[data-merge-panel="${INC_B}"]`, { timeout: 5000 });
  const targets = await cc.page.evaluate((id) => [...document.querySelectorAll(`#merge-target-${id} option`)].map((o) => o.value).filter(Boolean), INC_B);
  assert(targets.length === 1 && targets[0] === INC_A, `${rel}: the merge target list must offer the other open incident only (got ${JSON.stringify(targets)})`);
  await cc.page.selectOption(`#merge-target-${INC_B}`, INC_A);
  await cc.page.click(`[data-merge-panel="${INC_B}"] button:has-text("מזג לאירוע הנבחר")`);
  assert((await cc.page.textContent(`#merge-error-${INC_B}`)).includes('סיבה'), `${rel}: a merge without a reason must be refused in the UI`);
  assert(!SERVER.rpcLog.some((r) => r.name === 'merge_incident'), `${rel}: no merge call without a reason`);
  await cc.page.fill(`#merge-reason-${INC_B}`, 'same building, two medics');
  await cc.page.click(`[data-merge-panel="${INC_B}"] button:has-text("מזג לאירוע הנבחר")`);
  await cc.page.waitForTimeout(400);
  const call = SERVER.rpcLog.find((r) => r.name === 'merge_incident');
  assert(call && call.params.p_source_id === INC_B && call.params.p_target_id === INC_A && call.params.p_reason === 'same building, two medics', `${rel}: merge_incident must be called with B, A and the reason (got ${JSON.stringify(call)})`);
  assert(cc.toasts.some((t) => t.includes('P001→P001-BBBB')), `${rel}: the CC must be told which patient ids were renamed (got ${JSON.stringify(cc.toasts)})`);
  assert(SERVER.incidents.find((i) => i.id === INC_B).status === 'closed', `${rel}: B must be closed as merged`);

  // Events recorded in B before the merge now belong to A, stamped with their origin.
  assert(early.every((lid) => SERVER.events.some((e) => e.local_event_id === lid && e.incident_id === INC_A && e.origin_incident_id === INC_B)), `${rel}: B's events must be re-tagged to A with their origin`);

  // Medic 2 did not hear of the merge (offline) and records another casualty in B. Its push is
  // stored in A by the server (redirected_to), and the phone moves to A.
  await m2.page.evaluate(() => { saveLocalEvent({ type: 'QUICK_PATIENT_CREATED', patient_id: newUuid(), payload_json: { visual_id: 'P002' } }); });
  const m2Pending = await m2.page.evaluate((id) => getOutbox().filter((e) => !e.synced && e.incident_id === id).map((e) => e.local_event_id), INC_B);
  assert(m2Pending.length >= 1, `${rel}: medic 2 must have an unsent event pinned to B`);
  await m2.page.evaluate(() => syncPush());
  await m2.page.waitForFunction((id) => activeIncident?.id === id, INC_A, { timeout: 5000 });
  assert(m2Pending.every((lid) => SERVER.events.some((e) => e.local_event_id === lid && e.incident_id === INC_A && e.requested_incident_id === INC_B)), `${rel}: medic 2's late event must be stored in A`);
  assert(await m2.page.evaluate((ids) => ids.every((lid) => getOutbox().find((e) => e.local_event_id === lid)?.synced), m2Pending), `${rel}: the redirected event must count as sent`);
  assert(m2.toasts.some((t) => t.includes('אוחד') && t.includes('INC-AAAA')), `${rel}: medic 2 must be told the incident was merged (got ${JSON.stringify(m2.toasts)})`);

  // Medic 3 (nothing to push) moves on the next incident refresh.
  await m3.page.evaluate(() => refreshIncidentContext());
  await m3.page.waitForFunction((id) => activeIncident?.id === id, INC_A, { timeout: 5000 });
  assert((await m3.page.textContent('#incident-context-strip')).includes('INC-AAAA'), `${rel}: medic 3's strip must show the target incident`);

  const errors = [...m2.errors, ...m3.errors, ...pc.errors, ...cc.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: incident merge (D8) browser test passed`);
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
