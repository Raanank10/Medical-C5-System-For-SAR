// Real-browser test of the admin user-management screen (V2.99.31, database/042,
// supabase/functions/admin-users): only an admin sees the entry point, the admin picks the role
// per invitation, inviting or promoting to admin and deactivating ask for confirmation (and a
// dismissed confirmation sends nothing), the admin's own row has no controls, a one-time link is
// shown for copying, errors are shown in Hebrew, and an invite link that opens the app
// (?token_hash=...&type=invite) is verified by the app and then removed from the address bar.
//
// The Supabase client and the admin-users Edge Function are STUBBED here (an in-page fake that
// mimics the database/042 RPC contracts), so this proves client behavior only - not the server.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_admin_users_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEDIC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PENDING_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const FAKE_SUPABASE = `
(function(){
  const USERS={
    'admin@test':{id:'${ADMIN_ID}',role:'admin'},
    'cc@test':{id:'${CC_ID}',role:'cc'},
    'medic@test':{id:'${MEDIC_ID}',role:'medic'}
  };
  const load=(k,d)=>{ try{ return JSON.parse(localStorage.getItem('__fake_'+k))??d; }catch(e){ return d; } };
  const save=(k,v)=>localStorage.setItem('__fake_'+k, JSON.stringify(v));
  const now=new Date().toISOString();
  if(!load('directory',null)) save('directory',[
    {user_id:'${ADMIN_ID}',email:'admin@test',display_name:'Synthetic Admin',role:'admin',is_active:true,has_profile:true,has_password:true,invited_at:null,email_confirmed_at:now,last_sign_in_at:now,created_at:now},
    {user_id:'${CC_ID}',email:'cc@test',display_name:'Synthetic CC',role:'cc',is_active:true,has_profile:true,has_password:true,invited_at:null,email_confirmed_at:now,last_sign_in_at:now,created_at:now},
    {user_id:'${MEDIC_ID}',email:'medic@test',display_name:'Synthetic Medic',role:'medic',is_active:true,has_profile:true,has_password:true,invited_at:null,email_confirmed_at:now,last_sign_in_at:null,created_at:now},
    {user_id:'${PENDING_ID}',email:'pending@test',display_name:'Synthetic Pending',role:'pc',is_active:true,has_profile:true,has_password:false,invited_at:now,email_confirmed_at:null,last_sign_in_at:null,created_at:now}
  ]);
  window.__fakeRpcLog=load('rpclog',[]);
  window.__fakeOtpLog=load('otplog',[]);
  function logRpc(name,params){ window.__fakeRpcLog.push({name,params}); save('rpclog',window.__fakeRpcLog); }
  function session(){ return load('session',null); }
  function me(){ const s=session(); if(!s) return null; return Object.entries(USERS).map(([email,u])=>({email,...u})).find(u=>u.id===s.user.id)||null; }
  function builder(table){
    const b={_single:false};
    ['select','order','limit','eq','gte','gt','lt','lte','in','neq','is','range'].forEach(m=>{ b[m]=()=>b; });
    b.single=()=>{ b._single=true; return b; };
    b.maybeSingle=()=>{ b._single=true; return b; };
    b.then=(resolve,reject)=>{
      let data, error=null;
      const u=me();
      if(table==='profiles') data=u?{role:u.role,is_active:true}:null;
      else if(table==='admin_user_audit'){
        if(!u||u.role!=='admin'){ data=[]; }
        else data=[{created_at:now,actor_id:'${ADMIN_ID}',target_email:'pending@test',action:'invited',old_role:null,new_role:'pc',details:{delivery:'link'}},
                   {created_at:now,actor_id:null,target_email:'medic@test',action:'role_changed',old_role:'paramedic',new_role:'medic',details:{}}];
      }
      else data=b._single?null:[];
      return Promise.resolve({data,error}).then(resolve,reject);
    };
    return b;
  }
  function rpc(name,params){
    logRpc(name,params||{});
    const u=me();
    const ok=(data)=>Promise.resolve({data,error:null});
    const fail=(message)=>Promise.resolve({data:null,error:{message}});
    if(!u) return fail('no active profile');
    if(name==='list_open_incidents') return ok([]);
    if(name.startsWith('admin_')){
      if(u.role!=='admin') return fail('only an active admin can do this');
      const dir=load('directory',[]);
      if(name==='admin_list_users') return ok(dir);
      const row=dir.find(r=>r.user_id===params.p_user_id);
      if(!row) return fail('no profile for this user');
      if(params.p_user_id===u.id) return fail('an admin cannot change their own role');
      if(name==='admin_set_user_role') row.role=params.p_role;
      if(name==='admin_set_user_active') row.is_active=params.p_active;
      save('directory',dir);
      return ok(null);
    }
    return ok(null);
  }
  window.supabase={createClient:()=>({
    auth:{
      signInWithPassword:async({email})=>{ const u=USERS[email]; if(!u) return {data:null,error:{message:'bad'}}; save('session',{access_token:'tok-'+u.id,user:{id:u.id,email}}); return {data:{user:{id:u.id}},error:null}; },
      getSession:async()=>({data:{session:session()},error:null}),
      getUser:async()=>{ const u=me(); return {data:{user:u?{id:u.id,email:u.email}:null}}; },
      signOut:async()=>{ save('session',null); return {error:null}; },
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      verifyOtp:async(p)=>{ window.__fakeOtpLog.push(p); save('otplog',window.__fakeOtpLog);
        const s={access_token:'tok-new',user:{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',email:'invited@test'}}; return {data:{session:s,user:s.user},error:null}; },
      updateUser:async()=>({data:{user:{id:'ffffffff-ffff-4fff-8fff-ffffffffffff'}},error:null}),
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
const rpcCalls = (page, name) => page.evaluate((n) => window.__fakeRpcLog.filter((c) => c.name === n), name);

async function setupPage(browser, fnCalls, dialogs, policy, urlSuffix = '') {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (policy.next === 'dismiss') { policy.next = 'accept'; return d.dismiss(); }
    return d.accept();
  });
  await page.route('**/supabase-js@*/**', (route) => route.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/functions/v1/sync-log**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false, accepted: [], duplicates: [], rejected: [] }) }));
  await page.route('**/functions/v1/admin-users**', (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() || '{}');
    fnCalls.push({ body, auth: req.headers()['authorization'] });
    if (body.action === 'invite' && body.delivery === 'email') {
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'email_not_authorized' }) });
    }
    if (body.action === 'invite' && body.email === 'taken@test.example') {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'already_invited_different_role', existing_role: 'medic' }) });
    }
    const linkType = body.action === 'resend' && body.user_id !== PENDING_ID ? 'recovery' : 'invite';
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, user_id: PENDING_ID, delivery: 'link', link: `https://example.test/app/?token_hash=synthetic-${body.action}&type=${linkType}`, link_type: linkType, audit_logged: true }) });
  });
  return { context, page, pageErrors };
}

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const fnCalls = [];
  const dialogs = [];
  const policy = { next: 'accept' };
  const { context, page, pageErrors } = await setupPage(browser, fnCalls, dialogs, policy);
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await unlockOrSetupPin(page);

  // 1. A non-admin (cc) never sees the entry point.
  await login(page, 'cc@test');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  assert(!(await page.locator('#auth-admin-users-btn').isVisible()), `${rel}: cc must not see the user-management button`);
  await page.evaluate(() => openAdminUsers());
  assert(!(await page.locator('#screen-admin-users').evaluate((el) => el.classList.contains('active'))), `${rel}: cc must not be able to open the admin screen`);
  await page.evaluate(() => signOut());

  // 2. Admin: button visible, screen lists users, own row has no controls.
  await login(page, 'admin@test');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });
  assert(await page.locator('#auth-admin-users-btn').isVisible(), `${rel}: admin must see the user-management button`);
  await page.click('#auth-admin-users-btn');
  await page.waitForSelector('#screen-admin-users.active', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#admin-users-list [data-admin-user]').length === 4, null, { timeout: 5000 });
  const ownRow = page.locator(`#admin-users-list [data-admin-user="${ADMIN_ID}"]`);
  assert((await ownRow.textContent()).includes('החשבון שלך'), `${rel}: own row should be marked as your account`);
  assert((await ownRow.locator('select, button').count()) === 0, `${rel}: own row must have no role/deactivate/resend controls`);
  const pendingRow = page.locator(`#admin-users-list [data-admin-user="${PENDING_ID}"]`);
  assert((await pendingRow.textContent()).includes('ממתין להצטרפות'), `${rel}: never-confirmed user should show as pending`);
  assert((await pendingRow.locator('.admin-badge.pending').count()) === 1, `${rel}: pending must use the pending (not green) badge`);
  assert((await page.locator(`#admin-users-list [data-admin-user="${CC_ID}"] .admin-badge.active`).count()) === 1, `${rel}: confirmed user with password should show as active`);
  await page.waitForFunction(() => document.getElementById('admin-audit-list').textContent.includes('הוזמן'), null, { timeout: 5000 });
  assert((await page.textContent('#admin-audit-list')).includes('לא ידוע (שינוי ישיר במסד הנתונים)'), `${rel}: audit rows with no actor must say unknown actor`);

  // 3. Role is required: no role -> error, nothing sent.
  await page.fill('#admin-invite-email', 'newcc@test.example');
  await page.click('#admin-invite-btn');
  assert((await page.textContent('#admin-invite-error')).includes('יש לבחור תפקיד'), `${rel}: invite without a role must be refused`);
  assert(fnCalls.length === 0, `${rel}: no function call without a role`);

  // 4. Invite a CC by link: no confirmation, role sent as chosen, link shown for copying.
  await page.selectOption('#admin-invite-role', 'cc');
  await page.fill('#admin-invite-name', 'Synthetic New CC');
  const dialogsBefore = dialogs.length;
  await page.click('#admin-invite-btn');
  await page.waitForSelector('#admin-invite-result .admin-link-box input', { timeout: 5000 });
  assert(dialogs.length === dialogsBefore, `${rel}: inviting a non-admin role must not ask for confirmation`);
  const call = fnCalls[fnCalls.length - 1];
  assert(call.body.action === 'invite' && call.body.role === 'cc' && call.body.email === 'newcc@test.example' && call.body.delivery === 'link', `${rel}: invite body wrong: ${JSON.stringify(call.body)}`);
  assert(call.auth === `Bearer tok-${ADMIN_ID}`, `${rel}: invite must carry the admin's own session token`);
  assert((await page.inputValue('#admin-invite-result input')).includes('token_hash=synthetic-invite'), `${rel}: generated link should be shown`);
  assert((await page.inputValue('#admin-invite-email')) === '', `${rel}: form should clear after a successful invite`);

  // 5. Inviting an admin asks for confirmation; dismissing sends nothing, accepting sends it.
  await page.fill('#admin-invite-email', 'newadmin@test.example');
  await page.selectOption('#admin-invite-role', 'admin');
  const callsBefore = fnCalls.length;
  policy.next = 'dismiss';
  await page.click('#admin-invite-btn');
  await page.waitForTimeout(200);
  assert(dialogs[dialogs.length - 1].message.includes('אישור הזמנת מנהל מערכת'), `${rel}: admin invite must show the admin confirmation`);
  assert(fnCalls.length === callsBefore, `${rel}: dismissed admin confirmation must not send an invite`);
  await page.click('#admin-invite-btn');
  await page.waitForSelector('#admin-invite-result .admin-link-box', { timeout: 5000 });
  assert(fnCalls.length === callsBefore + 1 && fnCalls[fnCalls.length - 1].body.role === 'admin', `${rel}: accepted admin confirmation must send the admin invite`);

  // 6. Server error codes are shown in Hebrew (email path refused for non-team addresses).
  await page.fill('#admin-invite-email', 'someone@test.example');
  await page.selectOption('#admin-invite-role', 'medic');
  await page.check('input[name="admin-delivery"][value="email"]');
  await page.click('#admin-invite-btn');
  await page.waitForFunction(() => document.getElementById('admin-invite-error').textContent.length > 0, null, { timeout: 5000 });
  assert((await page.textContent('#admin-invite-error')).includes('חברי צוות הפרויקט'), `${rel}: email_not_authorized must explain the team-only restriction`);
  await page.check('input[name="admin-delivery"][value="link"]');
  await page.fill('#admin-invite-email', 'taken@test.example');
  await page.selectOption('#admin-invite-role', 'cc');
  await page.click('#admin-invite-btn');
  await page.waitForFunction(() => document.getElementById('admin-invite-error').textContent.includes('תפקיד אחר'), null, { timeout: 5000 });
  assert((await page.textContent('#admin-invite-error')).includes('חובש'), `${rel}: existing role should be named in Hebrew`);

  // 7. Change a role (confirmation, then RPC); promoting to admin uses the admin confirmation.
  const medicSelect = page.locator(`#admin-users-list [data-admin-user="${MEDIC_ID}"] select`);
  await medicSelect.selectOption('paramedic');
  await page.waitForFunction(() => window.__fakeRpcLog.some((c) => c.name === 'admin_set_user_role'), null, { timeout: 5000 });
  let roleCalls = await rpcCalls(page, 'admin_set_user_role');
  assert(roleCalls[0].params.p_user_id === MEDIC_ID && roleCalls[0].params.p_role === 'paramedic', `${rel}: role change RPC params wrong`);
  assert(dialogs[dialogs.length - 1].message.includes('לשנות את התפקיד'), `${rel}: role change must ask for confirmation`);
  await page.waitForFunction((id) => document.querySelector(`[data-admin-user="${id}"] select`)?.value === 'paramedic', MEDIC_ID, { timeout: 5000 });
  policy.next = 'dismiss';
  await page.locator(`#admin-users-list [data-admin-user="${MEDIC_ID}"] select`).selectOption('admin');
  await page.waitForTimeout(200);
  assert(dialogs[dialogs.length - 1].message.includes('אישור מינוי מנהל מערכת'), `${rel}: promotion to admin must show the admin confirmation`);
  roleCalls = await rpcCalls(page, 'admin_set_user_role');
  assert(roleCalls.length === 1, `${rel}: dismissed promotion must not call the RPC`);
  assert((await page.locator(`#admin-users-list [data-admin-user="${MEDIC_ID}"] select`).inputValue()) === 'paramedic', `${rel}: dismissed promotion must restore the select`);

  // 8. Deactivate (confirmation, RPC), then the row offers reactivation and no resend.
  await page.locator(`#admin-users-list [data-admin-user="${CC_ID}"] button`, { hasText: 'השבת' }).click();
  await page.waitForFunction(() => window.__fakeRpcLog.some((c) => c.name === 'admin_set_user_active'), null, { timeout: 5000 });
  const activeCalls = await rpcCalls(page, 'admin_set_user_active');
  assert(activeCalls[0].params.p_user_id === CC_ID && activeCalls[0].params.p_active === false, `${rel}: deactivate RPC params wrong`);
  assert(dialogs[dialogs.length - 1].message.includes('להשבית את'), `${rel}: deactivation must ask for confirmation`);
  await page.waitForFunction((id) => document.querySelector(`[data-admin-user="${id}"]`)?.textContent.includes('הפעל מחדש'), CC_ID, { timeout: 5000 });
  assert(await page.locator(`#admin-users-list [data-admin-user="${CC_ID}"] button`, { hasText: 'קישור' }).isDisabled(), `${rel}: no resend for a deactivated user`);

  // 9. Resend for a pending user -> new invite link in that row.
  await page.locator(`#admin-users-list [data-admin-user="${PENDING_ID}"] button`, { hasText: 'קישור הזמנה חדש' }).click();
  await page.waitForSelector(`[data-admin-user="${PENDING_ID}"] .admin-link-box input`, { timeout: 5000 });
  const resend = fnCalls[fnCalls.length - 1].body;
  assert(resend.action === 'resend' && resend.user_id === PENDING_ID, `${rel}: resend body wrong: ${JSON.stringify(resend)}`);

  // 10. Back returns to the screen the admin came from.
  await page.click('#screen-admin-users button:text-is("חזרה")');
  await page.waitForSelector('#screen-incident-picker.active', { timeout: 5000 });

  assert(pageErrors.length === 0, `${rel}: page errors: ${pageErrors.join(' | ')}`);
  await context.close();

  // 11. Opening an invite link: the app verifies the token itself and strips it from the URL.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on('pageerror', (err) => errors2.push(String(err)));
  await page2.route('**/supabase-js@*/**', (route) => route.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page2.goto('file://' + file + '?token_hash=synthetic-hash-1&type=invite', { waitUntil: 'domcontentloaded' });
  assert((await page2.evaluate(() => location.search)).includes('token_hash'), `${rel}: token must survive until the app has tried it (reload at the PIN screen)`);
  await unlockOrSetupPin(page2);
  await page2.waitForSelector('#screen-set-password.active', { timeout: 5000 });
  assert(!(await page2.evaluate(() => location.search)).includes('token_hash'), `${rel}: token must be removed from the address bar once verified`);
  const otp = await page2.evaluate(() => window.__fakeOtpLog);
  assert(otp.length === 1 && otp[0].token_hash === 'synthetic-hash-1' && otp[0].type === 'invite', `${rel}: app must verify the invite token itself: ${JSON.stringify(otp)}`);
  assert(errors2.length === 0, `${rel}: page errors on invite link: ${errors2.join(' | ')}`);
  await ctx2.close();

  console.log(`${rel}: admin user management browser test passed`);
}

(async () => {
  // Cloud sessions pre-install Chromium here; elsewhere Playwright's own download is used.
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
