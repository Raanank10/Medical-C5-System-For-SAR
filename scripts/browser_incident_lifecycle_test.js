// Real-browser test of the logged-in incident lifecycle UI (V2.99.26, database/038): the app
// starts with no incident and no patients, a medic opens a draft incident, events are pinned to
// that incident at creation, command sees the pulsing approval banner and confirms it, and the
// local demo mode still works after sign-out. Also the incident close guard (V2.99.28,
// database/040): no close while patients are open, medical-command override with a mandatory
// reason, no override for rescue command, and the same rule in local demo mode.
//
// The Supabase client and the sync-log Edge Function are STUBBED here (an in-page fake that
// mimics the database/038 RPC contracts), so this proves client behavior only - it does not
// prove the server side. The server side was verified separately against the live project by
// role impersonation (docs/RLS_AUDIT_v1.md, "Follow-up: incident lifecycle RPCs").
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_incident_lifecycle_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html'), path.join(root, 'demo', 'rescue-app.html')];
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// In-page fake of window.supabase. State lives in localStorage under __fake_* keys so it
// survives a page reload (session restore) the way a real backend would.
const FAKE_SUPABASE = `
(function(){
  const USERS={
    'medic@test':{id:'11111111-1111-4111-8111-111111111111',role:'medic'},
    'pc@test':{id:'22222222-2222-4222-8222-222222222222',role:'pc'},
    'cc@test':{id:'33333333-3333-4333-8333-333333333333',role:'cc'},
    'logo@test':{id:'44444444-4444-4444-8444-444444444444',role:'logistics_officer'},
    'rpc@test':{id:'55555555-5555-4555-8555-555555555555',role:'rpc'}
  };
  const load=(k,d)=>{ try{ return JSON.parse(localStorage.getItem('__fake_'+k))??d; }catch(e){ return d; } };
  const save=(k,v)=>localStorage.setItem('__fake_'+k, JSON.stringify(v));
  window.__fakeRpcLog=load('rpclog',[]);
  function logRpc(name,params){ window.__fakeRpcLog.push({name,params}); save('rpclog',window.__fakeRpcLog); }
  function session(){ return load('session',null); }
  function userById(id){ return Object.entries(USERS).map(([email,u])=>({email,...u})).find(u=>u.id===id); }
  function builder(table){
    const b={_single:false,_filters:{}};
    const chain=['select','order','limit','gte','gt','lt','lte','in','neq','is','upsert','insert','update','delete','range'];
    chain.forEach(m=>{ b[m]=()=>b; });
    b.eq=(col,val)=>{ b._filters[col]=val; return b; };
    b.single=()=>{ b._single=true; return b; };
    b.maybeSingle=()=>{ b._single=true; return b; };
    b.then=(resolve,reject)=>{
      let data;
      const s=session();
      if(table==='profiles'){ const u=s&&userById(s.user.id); data=u?{role:u.role,is_active:true}:null; }
      else if(table==='incidents'){ const inc=load('incidents',[]).find(i=>i.id===b._filters.id); data=inc?{status:inc.status,metadata:inc.metadata||{}}:null; }
      else data=b._single?null:[];
      return Promise.resolve({data,error:null}).then(resolve,reject);
    };
    return b;
  }
  function rpc(name,params){
    logRpc(name,params||{});
    const s=session(); const me=s&&userById(s.user.id);
    const incidents=load('incidents',[]); const members=load('members',[]);
    const ok=(data)=>Promise.resolve({data,error:null});
    const fail=(message)=>Promise.resolve({data:null,error:{message}});
    if(!me) return fail('no active profile');
    const command=['pc','cc','chamal','admin','physician'].includes(me.role);
    if(name==='list_open_incidents'){
      return ok(incidents.filter(i=>['draft','staging','active'].includes(i.status)).map(i=>({...i,patient_count:0,
        opened_by_name:userById(i.opened_by||i.draft_created_by)?.email||null,
        is_member:members.some(m=>m.incident_id===i.id&&m.profile_id===me.id)})));
    }
    if(name==='open_incident'){
      if(me.role==='logistics_officer') return fail('role logistics_officer cannot open an incident');
      const status=['medic','paramedic'].includes(me.role)?'draft':'active';
      const inc={id:params.p_incident_id,visual_id:'INC-TEST-'+params.p_incident_id.slice(0,6).toUpperCase(),status,
        location_name:params.p_location_name,address:params.p_address,incident_type:params.p_incident_type,
        opened_at:new Date().toISOString(),draft_created_by:status==='draft'?me.id:null,opened_by:status==='active'?me.id:null,
        draft_acknowledged_at:null,metadata:{}};
      incidents.push(inc); save('incidents',incidents);
      members.push({incident_id:inc.id,profile_id:me.id}); save('members',members);
      return ok({id:inc.id,visual_id:inc.visual_id,status,created:true});
    }
    if(name==='join_incident'){
      members.push({incident_id:params.p_incident_id,profile_id:me.id}); save('members',members);
      return ok({id:params.p_incident_id});
    }
    const inc=incidents.find(i=>i.id===params?.p_incident_id);
    if(['confirm_draft','reject_draft','acknowledge_draft'].includes(name)){
      if(!command) return fail('only command roles');
      if(!inc||inc.status!=='draft') return fail('not a draft');
      if(name==='confirm_draft'){ inc.status='active'; inc.metadata={draft_resolution:'confirmed'}; }
      if(name==='reject_draft'){ inc.status='closed'; inc.metadata={draft_resolution:'rejected'}; }
      if(name==='acknowledge_draft'){ inc.draft_acknowledged_at=new Date().toISOString(); }
      save('incidents',incidents);
      return ok({id:inc.id});
    }
    // database/040 contract. Open patients per incident come from __fake_openpatients.
    if(name==='close_incident'||name==='reopen_incident'){
      if(!['pc','cc','chamal','admin','physician','rpc','rcc'].includes(me.role)) return fail('role '+me.role+' cannot close an incident');
      if(!inc) return fail('not found');
      if(name==='reopen_incident'){ if(inc.status!=='closed') return ok({status:inc.status,changed:false}); inc.status='active'; save('incidents',incidents); return ok({status:'active',changed:true}); }
      if(inc.status==='closed') return ok({closed:true,changed:false});
      if(inc.status==='draft') return fail('draft');
      const open=(load('openpatients',{})[inc.id])||[];
      const canOverride=command;
      const reason=(params.p_override_reason||'').trim()||null;
      if(open.length && (!reason||!canOverride)) return ok({closed:false,open_patient_count:open.length,open_patients:open,can_override:canOverride,reason_required:canOverride});
      inc.status='closed'; if(open.length) inc.metadata={...(inc.metadata||{}),close_override:{reason,role:me.role}};
      save('incidents',incidents);
      return ok({closed:true,changed:true,override:open.length>0,open_patient_count:open.length});
    }
    if(name==='get_incident_command_state') return ok(inc?{incident_id:inc.id,status:inc.status,active_red_patients:2,total_patients:5,patients_missing_full_vitals:1,active_watchdog_alerts:3,state_json:{}}:null);
    return ok(null);
  }
  window.supabase={createClient:()=>({
    auth:{
      signInWithPassword:async({email})=>{ const u=USERS[email]; if(!u) return {data:null,error:{message:'bad'}}; save('session',{access_token:'tok-'+u.id,user:{id:u.id}}); return {data:{user:{id:u.id}},error:null}; },
      getSession:async()=>({data:{session:session()},error:null}),
      getUser:async()=>{ const s=session(); const u=s&&userById(s.user.id); return {data:{user:u?{id:u.id,email:u.email}:null}}; },
      signOut:async()=>{ save('session',null); return {error:null}; },
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      verifyOtp:async()=>({error:{message:'n/a'}}),
      updateUser:async()=>({error:null}),
      resetPasswordForEmail:async()=>({error:null})
    },
    from:(t)=>builder(t),
    rpc
  })};
})();`;

async function unlockOrSetupPin(page) {
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  if (await page.locator('#pin-gate-setup-panel').isVisible()) {
    await page.fill('#pin-gate-setup-new', PIN);
    await page.fill('#pin-gate-setup-confirm', PIN);
    await page.click('#pin-gate-setup-btn');
  } else {
    await page.fill('#pin-gate-unlock-input', PIN);
    await page.click('#pin-gate-unlock-btn');
  }
}
async function login(page, email) {
  await page.waitForSelector('#screen-login.active', { timeout: 5000 });
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'synthetic');
  await page.click('#login-submit-btn');
}
const activeScreen = (page) => page.evaluate(() => document.querySelector('.screen.active')?.id);

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'test reason' : undefined));
  const pushes = [];
  await page.route('**/supabase-js@*/**', (route) => route.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/functions/v1/sync-log**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      pushes.push(body);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: (body.events || []).map((e) => ({ local_event_id: e.local_event_id })), duplicates: [], rejected: [] }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) });
  });

  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await unlockOrSetupPin(page);

  // 1. Medic: no incident yet -> picker, empty, draft wording, no demo patients.
  await login(page, 'medic@test');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  assert((await page.textContent('#incident-picker-list')).includes('אין אירועים פתוחים'), `${rel}: medic should see an empty incident list`);
  assert((await page.textContent('#incident-open-title')).includes('טיוטת'), `${rel}: medic open panel should say draft`);
  assert(await page.evaluate(() => patients.length === 0), `${rel}: logged-in medic must start with zero patients`);

  // 2. Medic opens a draft -> en-route screen, draft strip, address prefilled.
  await page.fill('#incident-open-location', 'Synthetic Site Alpha');
  await page.fill('#incident-open-address', 'Synthetic Street 1');
  await page.click('#incident-open-btn');
  await page.waitForSelector('#screen-enroute.active', { timeout: 5000 });
  const draftId = await page.evaluate(() => activeIncident.id);
  assert(/^[0-9a-f-]{36}$/.test(draftId), `${rel}: active incident id should be a client UUID, got ${draftId}`);
  assert((await page.textContent('#incident-context-strip')).includes('ממתין לאישור'), `${rel}: strip should show the draft status`);
  assert(await page.evaluate(() => document.getElementById('incident-context-strip').classList.contains('draft')), `${rel}: strip should use the draft style`);
  assert((await page.inputValue('#enroute-address')) === 'Synthetic Street 1', `${rel}: en-route address should be prefilled from the incident`);
  assert(await page.evaluate((id) => SITE_TO_INCIDENT_ID.SITE_A === id && !('SITE_B' in SITE_TO_INCIDENT_ID), draftId), `${rel}: SITE_A must map to the draft and SITE_B must be gone`);
  assert(await page.evaluate(() => !allSites.some((s) => s.id === 'SITE_B')), `${rel}: local-demo SITE_B must be hidden while logged in`);

  // 3. Events are pinned to the incident at creation; an unstamped legacy entry is rejected locally, never pushed.
  await page.evaluate(() => {
    getOutbox().push({ local_event_id: 'legacy-unstamped-1', local_timestamp: new Date().toISOString(), type: 'QUICK_PATIENT_CREATED', siteId: 'SITE_A', synced: false, payload_json: {} });
    saveLocalEvent({ type: 'QUICK_PATIENT_CREATED', patient_id: newUuid(), payload_json: { visual_id: 'P001' } });
  });
  await page.evaluate(() => syncPush());
  const stamped = await page.evaluate((id) => getOutbox().filter((e) => e.incident_id === id).length, draftId);
  assert(stamped >= 1, `${rel}: new outbox entries must carry incident_id`);
  const pushedIncidents = [...new Set(pushes.map((p) => p.incident_id))];
  assert(pushedIncidents.length === 1 && pushedIncidents[0] === draftId, `${rel}: pushes must target only the draft incident, got ${JSON.stringify(pushedIncidents)}`);
  assert(!pushes.some((p) => p.events.some((e) => e.local_event_id === 'legacy-unstamped-1')), `${rel}: an unstamped entry must never be pushed`);
  const legacy = await page.evaluate(() => getOutbox().find((e) => e.local_event_id === 'legacy-unstamped-1'));
  assert(legacy.syncRejected && legacy.syncRejectReason === 'no_incident_context', `${rel}: unstamped entry must be visibly rejected, got ${JSON.stringify(legacy)}`);

  // 3b. Triage sync (V2.99.27): local triage reaches the server as PATIENT_TRIAGE_UPDATED /
  // PATIENT_TRIAGED_EXPECTANT, only after the patient's create event, and server 'pending'
  // never overwrites a real local triage.
  const tri = await page.evaluate(() => {
    const mk = (triage) => ({ id: newUuid(), visualId: 'T' + Math.floor(Math.random() * 1000), triage, patientStatus: 'identified', events: [], siteId: 'SITE_A' });
    const p1 = mk('red'); const p2 = mk('yellow');
    patients.push(p1, p2);
    saveLocalEvent({ type: 'QUICK_PATIENT_CREATED', patient_id: p1.id, payload_json: { visual_id: p1.visualId, triage: 'red' } });
    saveDemoState();
    const ob = () => getOutbox();
    const idx = (pid, type) => ob().findIndex((e) => e.patient_id === pid && e.type === type);
    const r = {
      createIdx: idx(p1.id, 'QUICK_PATIENT_CREATED'),
      triageIdx: idx(p1.id, 'PATIENT_TRIAGE_UPDATED'),
      redPayload: ob().find((e) => e.patient_id === p1.id && e.type === 'PATIENT_TRIAGE_UPDATED')?.payload_json?.triage,
      p2Deferred: !ob().some((e) => e.patient_id === p2.id),
      incidentStamped: ob().filter((e) => e.patient_id === p1.id).every((e) => e.incident_id === activeIncident.id),
    };
    saveDemoState();
    r.noDuplicate = ob().filter((e) => e.patient_id === p1.id && e.type === 'PATIENT_TRIAGE_UPDATED').length === 1;
    p1.triage = 'yellow'; saveDemoState();
    r.yellow = ob().filter((e) => e.patient_id === p1.id && e.type === 'PATIENT_TRIAGE_UPDATED').map((e) => e.payload_json.triage).join(',');
    p1.triage = 'black'; saveDemoState();
    r.black = ob().some((e) => e.patient_id === p1.id && e.type === 'PATIENT_TRIAGED_EXPECTANT' && e.payload_json.current_triage === 'black');
    window.__p1 = p1.id;
    return r;
  });
  assert(tri.createIdx >= 0 && tri.triageIdx > tri.createIdx, `${rel}: triage event must follow the create event (${JSON.stringify(tri)})`);
  assert(tri.redPayload === 'red', `${rel}: triage event must carry red`);
  assert(tri.p2Deferred, `${rel}: no triage event before the patient's create event`);
  assert(tri.incidentStamped, `${rel}: triage events must be pinned to the incident`);
  assert(tri.noDuplicate, `${rel}: an unchanged triage must not be re-sent`);
  assert(tri.yellow === 'red,yellow', `${rel}: a triage change must be sent, got ${tri.yellow}`);
  assert(tri.black, `${rel}: black must be sent as PATIENT_TRIAGED_EXPECTANT`);
  await page.evaluate(() => syncPush());
  const pull = await page.evaluate(() => {
    const id = window.__p1;
    const row = (t, v) => ({ id, incident_id: activeIncident.id, visual_id: 'T', current_triage: t, current_status: 'identified', access_status: null, needs_full_assessment: false, version: v });
    const count = () => getOutbox().filter((e) => e.patient_id === id && ['PATIENT_TRIAGE_UPDATED', 'PATIENT_TRIAGED_EXPECTANT'].includes(e.type)).length;
    const before = count();
    applyProjectedPatientState([row('pending', 50)]);
    const keptLocal = patients.find((p) => p.id === id).triage;
    applyProjectedPatientState([row('red', 51)]);
    const tookServer = patients.find((p) => p.id === id).triage;
    saveDemoState();
    return { keptLocal, tookServer, echoed: count() !== before };
  });
  assert(pull.keptLocal === 'black', `${rel}: server 'pending' must not overwrite local triage, got ${pull.keptLocal}`);
  assert(pull.tookServer === 'red', `${rel}: a real server triage must win locally, got ${pull.tookServer}`);
  assert(!pull.echoed, `${rel}: an accepted server triage must not be echoed back`);

  // 3c. The sandboxed briefing demo (V2.99.25) creates a red patient while signed in; the triage
  // reconciler must not turn it into outbox events, and ending the demo restores everything.
  const sandboxBefore = await page.evaluate(() => ({ ob: JSON.stringify(getOutbox()), ids: patients.map((p) => p.id + p.triage).join(',') }));
  await page.evaluate(() => startBriefingDemo());
  await page.waitForFunction(() => patients.some((p) => p.triage === 'red'), { timeout: 8000 });
  await page.evaluate(() => { saveDemoState(); syncPush(); });
  const sandboxDuring = await page.evaluate(() => JSON.stringify(getOutbox()));
  await page.evaluate(() => endBriefingDemo());
  const sandboxAfter = await page.evaluate(() => ({ ob: JSON.stringify(getOutbox()), ids: patients.map((p) => p.id + p.triage).join(',') }));
  assert(sandboxDuring === sandboxBefore.ob, `${rel}: the sandboxed demo must not add outbox events while signed in`);
  assert(sandboxAfter.ob === sandboxBefore.ob && sandboxAfter.ids === sandboxBefore.ids, `${rel}: ending the sandboxed demo must restore patients and outbox exactly`);

  // 4. Local-demo clearers are refused while logged in (they would wipe real unsynced events).
  // The demo patient loaders themselves were removed in V2.99.24.
  const outboxBefore = await page.evaluate(() => getOutbox().length);
  await page.evaluate(() => { clearDemoPatientsOnly({ confirmReset: false }); clearDemoScenario({ confirmReset: false }); });
  assert(await page.evaluate(() => getOutbox().length) === outboxBefore && outboxBefore >= 2, `${rel}: demo clearers must not wipe the outbox while logged in`);

  // 5. Reload: session restore resumes the stored incident instead of the picker.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await unlockOrSetupPin(page);
  await page.waitForFunction(() => ['screen-enroute', 'screen-incident-picker'].includes(document.querySelector('.screen.active')?.id), { timeout: 5000 });
  assert((await activeScreen(page)) === 'screen-enroute', `${rel}: reload should resume the medic's incident, got ${await activeScreen(page)}`);
  assert(await page.evaluate((id) => activeIncident?.id === id, draftId), `${rel}: resumed incident should be the draft`);

  // 6. PC: pulsing approval banner, acknowledge, confirm; no demo patients on the role dashboard.
  await page.evaluate(() => signOut());
  await login(page, 'pc@test');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('draft-approval-banner').style.display === 'flex', { timeout: 5000 });
  assert(await page.evaluate(() => document.getElementById('draft-approval-banner').classList.contains('pulse')), `${rel}: unacknowledged draft banner should pulse`);
  await page.click('#draft-approval-banner button:has-text("ראיתי")');
  await page.waitForFunction(() => !document.getElementById('draft-approval-banner').classList.contains('pulse'), { timeout: 5000 });
  await page.click('#draft-approval-banner button:has-text("אשר")');
  await page.waitForFunction(() => document.getElementById('draft-approval-banner').style.display === 'none', { timeout: 5000 });
  const rpcNames = await page.evaluate(() => window.__fakeRpcLog.map((r) => r.name));
  assert(rpcNames.includes('acknowledge_draft') && rpcNames.includes('confirm_draft'), `${rel}: expected acknowledge_draft and confirm_draft calls, got ${rpcNames.join(',')}`);
  await page.click(`#incident-picker-list button:has-text("הצטרף לאירוע")`);
  await page.waitForSelector('#screen-role-dashboard.active', { timeout: 5000 });
  assert(await page.evaluate(() => patients.length === 0), `${rel}: logged-in PC dashboard must not auto-load demo patients`);
  assert((await page.textContent('#incident-context-strip')).includes('פעיל'), `${rel}: strip should show the confirmed incident as active`);

  // 6b. Close guard (V2.99.28): PC cannot close while patients are open; override needs a reason.
  await page.evaluate((id) => localStorage.setItem('__fake_openpatients', JSON.stringify({ [id]: [
    { id: 'p1', visual_id: 'P101', triage: 'red', status: 'evacuating' },
    { id: 'p2', visual_id: 'P102', triage: 'pending', status: 'identified' }] })), draftId);
  const stripClose = page.locator('#incident-strip-close-btn');
  assert(await stripClose.isVisible(), `${rel}: PC should see the close button on the incident strip`);
  await stripClose.click();
  await page.waitForSelector('#incident-close-modal:not(.hidden)', { timeout: 5000 });
  assert((await page.locator('#incident-close-list .close-guard-row').count()) === 2, `${rel}: close modal should list the 2 open patients`);
  assert((await page.textContent('#incident-close-list')).includes('P101'), `${rel}: close modal should name open patients by visual id`);
  assert(await page.locator('#incident-close-override-btn').isVisible(), `${rel}: PC should be offered the override`);
  await page.click('#incident-close-override-btn');
  assert((await page.textContent('#incident-close-error')).includes('חובה'), `${rel}: override without a reason must be refused`);
  assert(await page.evaluate(() => activeIncident.status === 'active'), `${rel}: incident must stay open after a reasonless override attempt`);
  await page.fill('#incident-close-reason', 'synthetic override reason');
  await page.click('#incident-close-override-btn');
  await page.waitForSelector('#incident-close-modal.hidden', { state: 'attached', timeout: 5000 });
  await page.waitForFunction(() => activeIncident.status === 'closed', { timeout: 5000 });
  const lastClose = await page.evaluate(() => window.__fakeRpcLog.filter((r) => r.name === 'close_incident').pop().params);
  assert(lastClose.p_override_reason === 'synthetic override reason', `${rel}: override reason must be sent to close_incident`);
  assert((await page.textContent('#incident-context-strip')).includes('סגור'), `${rel}: strip should show the incident as closed`);
  assert((await stripClose.textContent()).includes('פתח אירוע מחדש'), `${rel}: strip button should offer reopen once closed`);
  await stripClose.click(); // confirm() auto-accepted
  await page.waitForFunction(() => activeIncident.status === 'active', { timeout: 5000 });
  assert(await page.evaluate(() => window.__fakeRpcLog.some((r) => r.name === 'reopen_incident')), `${rel}: reopen must go through reopen_incident`);

  // 7. CC: overview of all open incidents with server counts.
  await page.evaluate(() => signOut());
  await login(page, 'cc@test');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('incident-picker-list').textContent.includes('אדומים פעילים'), { timeout: 5000 });
  assert((await page.textContent('#incident-picker-list')).includes('Synthetic Site Alpha'), `${rel}: CC overview should list the incident`);

  await page.click('#incident-picker-list button:has-text("כניסה")');
  await page.waitForSelector('#screen-role-dashboard.active', { timeout: 5000 });
  const ccEmits = await page.evaluate(() => {
    const p = { id: newUuid(), visualId: 'TCC', triage: 'red', patientStatus: 'identified', events: [], siteId: 'SITE_A', _serverVersion: 1 };
    patients.push(p); saveDemoState();
    return getOutbox().some((e) => e.patient_id === p.id);
  });
  assert(!ccEmits, `${rel}: CC must not emit triage events (sync-log would reject them)`);

  // 7b. Rescue command (rpc): may close, may not override; closes once everything is handed over.
  await page.evaluate(() => signOut());
  await login(page, 'rpc@test');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#incident-picker-list button'), { timeout: 5000 });
  await page.click('#incident-picker-list button:has-text("כניסה")');
  await page.waitForSelector('#screen-role-dashboard.active', { timeout: 5000 });
  const rescueClose = page.locator('#screen-role-dashboard button:has-text("סגור אירוע")');
  await rescueClose.click();
  await page.waitForSelector('#incident-close-modal:not(.hidden)', { timeout: 5000 });
  assert(!(await page.locator('#incident-close-override-btn').isVisible()), `${rel}: rpc must not be offered the override`);
  assert(!(await page.locator('#incident-close-override').isVisible()), `${rel}: rpc must not see the override reason field`);
  await page.click('#incident-close-modal button:has-text("חזרה")');
  assert(await page.evaluate(() => activeIncident.status === 'active'), `${rel}: incident must stay open for rpc while patients are open`);
  await page.evaluate(() => localStorage.setItem('__fake_openpatients', '{}'));
  await rescueClose.click();
  await page.waitForFunction(() => activeIncident.status === 'closed', { timeout: 5000 });
  assert(await page.locator('#incident-close-modal').evaluate((el) => el.classList.contains('hidden')), `${rel}: no modal when every patient is handed over`);
  assert(await page.evaluate(() => siteAuthority.SITE_A.incidentStatus === 'closed'), `${rel}: rescue panel status must mirror the server close`);
  assert(await page.locator('#screen-role-dashboard button:has-text("פתח אירוע מחדש")').isVisible(), `${rel}: rescue panel should offer reopen once closed`);

  // 8. Logistics cannot open incidents.
  await page.evaluate(() => signOut());
  await login(page, 'logo@test');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  assert(!(await page.locator('#incident-open-panel').isVisible()), `${rel}: logistics must not see the open-incident panel`);

  // 9. Sign out -> local demo mode is intact (SITE_B back) and starts with no patients (V2.99.24).
  await page.evaluate(() => signOut());
  await page.waitForSelector('#screen-login.active', { timeout: 5000 });
  assert(await page.evaluate(() => allSites.some((s) => s.id === 'SITE_B') && SITE_TO_INCIDENT_ID.SITE_B), `${rel}: local demo sites must be restored after sign-out`);
  await page.evaluate(() => { goTo('demo'); startRoleDashboard('pc'); });
  assert(await page.evaluate(() => patients.length === 0), `${rel}: local demo mode must start with no patients after sign-out`);
  assert(!(await page.locator('#incident-context-strip').isVisible()), `${rel}: incident strip must be hidden in local demo mode`);
  assert(await page.evaluate(() => siteAuthority.SITE_A.incidentStatus !== 'closed'), `${rel}: a server close must not leak into local demo site authority`);

  // 10. Local demo mode applies the same close guard to its local patients (local mode starts
  // empty since V2.99.24, so the test creates its own local patient).
  await page.evaluate(() => startRoleDashboard('rpc'));
  await page.waitForSelector('#screen-role-dashboard.active', { timeout: 5000 });
  await page.evaluate(() => { patients.push({ id: newUuid(), visualId: 'L01', triage: 'red', patientStatus: 'evacuating', events: [], siteId: 'SITE_A' }); renderRoleDashboard('rpc'); });
  await page.click('#screen-role-dashboard button:has-text("סגור אירוע")');
  await page.waitForSelector('#incident-close-modal:not(.hidden)', { timeout: 5000 });
  assert((await page.textContent('#incident-close-list')).includes('L01'), `${rel}: local close guard should list the open local patient`);
  assert(!(await page.locator('#incident-close-override-btn').isVisible()), `${rel}: local rpc must not be offered the override`);
  await page.click('#incident-close-modal button:has-text("חזרה")');
  assert(await page.evaluate(() => siteAuthority.SITE_A.incidentStatus !== 'closed'), `${rel}: local incident must stay open while a local patient is open`);
  await page.evaluate(() => { patients[0].patientStatus = 'handed_over'; });
  await page.click('#screen-role-dashboard button:has-text("סגור אירוע")');
  assert(await page.evaluate(() => siteAuthority.SITE_A.incidentStatus === 'closed'), `${rel}: local incident should close once every patient is handed over`);
  assert(await page.locator('#incident-close-modal').evaluate((el) => el.classList.contains('hidden')), `${rel}: no local close dialog when nothing is open`);
  assert(await page.evaluate(() => getOutbox().some((e) => e.type === 'INCIDENT_CLOSE_TOGGLED' && e.payload_json.newStatus === 'closed' && !e.incident_id)), `${rel}: local close must be logged as a local (unstamped) event`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: incident lifecycle browser test passed`);
}

(async () => {
  // Same browser selection as scripts/browser_smoke_test.js: prefer a pre-installed Chromium.
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const file of files) await checkFile(browser, file);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
