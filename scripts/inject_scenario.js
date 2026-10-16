#!/usr/bin/env node
// Synthetic scenario injector (option B for field experiments): virtual medics push a scripted
// synthetic MCI timeline into a REAL incident through the REAL /sync/log Edge Function - the
// exact path a phone uses - so PC/CC screens see the incident unfold live. Real people (option
// A) can work in the same incident at the same time.
//
// Synthetic data only (docs/OPERATIONS_SAFETY.md). Every injected event carries
// payload_json.synthetic_source='injector' (+ scenario_id, run_id) so the AAR/analytics can
// separate injected activity from human activity afterwards. Participants never see that tag.
//
// Stdlib only (Node >= 18 for global fetch). No credentials in the repo: virtual-medic
// accounts come from a JSON file you keep outside the repo (see scenarios/README.md).
//
// Usage:
//   node scripts/inject_scenario.js --scenario scenarios/small_site_alpha_v1.json --dry-run
//   node scripts/inject_scenario.js --scenario <file> --accounts <accounts.json> --open-draft
//   node scripts/inject_scenario.js --scenario <file> --accounts <accounts.json> --join <incident_id>
// Options:
//   --speed <n>            run the clock n times faster (rehearsal/testing), default 1
//   --inject <name>@<m:ss> schedule a named inject at a fixed time (repeatable)
//   --visual-prefix <s>    prefix every patient visual id (needed when re-running into the
//                          same incident: visual ids are unique per incident)
//   --dry-run              validate and print the timeline, no network
// While running, type an inject name to fire it now, or: list, status, quit.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// Same public project URL / anon key as index.html (the anon key identifies the app, it is not
// a privilege - docs/THREAT_MODEL.md T7). --base-url exists only for the offline test harness.
const DEFAULT_BASE_URL = 'https://btvvjmuwdzirjyauyijx.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0dnZqbXV3ZHppcmp5YXV5aWp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMTYzNjUsImV4cCI6MjEwMjY5MjM2NX0.bKWklZKs8xEtMqXUvNBDEn0AIPOps0N1ycjc9idLAVE';
const HEARTBEAT_MS = 30000; // real devices heartbeat every 45s; 30s keeps virtual medics clearly "alive"

// Client vocabularies (index.html) - validated so injected data renders exactly like real data.
const TRIAGE = ['red', 'yellow', 'green', 'black'];
const AVPU = ['A', 'V', 'P', 'U'];
const BP = ['radial_strong', 'radial_weak', 'carotid_strong', 'carotid_weak', 'absent'];
const LIMBS = ['right_arm', 'left_arm', 'right_leg', 'left_leg'];
const TRAP = ['trapped', 'not_trapped'];
const STATUSES = ['identified', 'stabilizing', 'observing', 'evacuating'];
// tourniquets_clinical_context_check (live CHECK constraint) - anything else fails the projection
// trigger and the whole TOURNIQUET_APPLIED event is rejected.
const TQ_CONTEXTS = ['arterial_bleed', 'amputation', 'crush_entrapment', 'venous_bleed', 'uncertain', 'unknown'];
const ACTIONS = ['create', 'vitals', 'triage', 'access', 'tourniquet', 'status', 'handover', 'expectant', 'silence', 'resume', 'note'];

function fail(msg) { console.error(`Error: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const a = { inject: [], speed: 1, visualPrefix: '', baseUrl: DEFAULT_BASE_URL };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail(`${k} needs a value`); return argv[++i]; };
    if (k === '--scenario') a.scenario = next();
    else if (k === '--accounts') a.accounts = next();
    else if (k === '--open-draft') a.openDraft = true;
    else if (k === '--join') a.join = next();
    else if (k === '--speed') a.speed = Number(next());
    else if (k === '--inject') a.inject.push(next());
    else if (k === '--visual-prefix') a.visualPrefix = next();
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--base-url') a.baseUrl = next();
    else fail(`unknown option ${k}`);
  }
  if (!a.scenario) fail('--scenario is required');
  if (!(a.speed > 0)) fail('--speed must be a positive number');
  if (!a.dryRun) {
    if (!a.accounts) fail('--accounts is required (or use --dry-run)');
    if (!!a.openDraft === !!a.join) fail('choose exactly one of --open-draft or --join <incident_id>');
  }
  return a;
}

function parseTime(t, where) {
  const m = /^(\d+):([0-5]\d)$/.exec(String(t));
  if (!m) fail(`${where}: time "${t}" must be m:ss`);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000;
}
function fmt(ms) { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function validateStep(step, where, scenario, created) {
  if (!ACTIONS.includes(step.action)) fail(`${where}: unknown action "${step.action}"`);
  if (!scenario.actors[step.actor]) fail(`${where}: unknown actor "${step.actor}"`);
  const needsPatient = !['silence', 'resume', 'note'].includes(step.action);
  if (needsPatient) {
    if (!step.patient) fail(`${where}: "${step.action}" needs a patient`);
    if (step.action === 'create') {
      if (created.has(step.patient)) fail(`${where}: patient ${step.patient} created twice`);
      created.add(step.patient);
    } else if (!created.has(step.patient)) fail(`${where}: patient ${step.patient} used before it is created`);
  }
  const v = step.vitals;
  if (v) {
    if (!(v.pulse >= 0 && v.pulse <= 250)) fail(`${where}: implausible pulse ${v.pulse}`);
    if (!(v.rr >= 0 && v.rr <= 70)) fail(`${where}: implausible rr ${v.rr}`);
    if (v.spo2 != null && !(v.spo2 >= 50 && v.spo2 <= 100)) fail(`${where}: implausible spo2 ${v.spo2}`);
    if (!AVPU.includes(v.avpu)) fail(`${where}: avpu must be one of ${AVPU}`);
    if (v.bp_estimate && !BP.includes(v.bp_estimate)) fail(`${where}: bp_estimate must be one of ${BP}`);
  }
  if (step.triage && !TRIAGE.includes(step.triage)) fail(`${where}: triage must be one of ${TRIAGE}`);
  if (step.action === 'create' && !step.triage) fail(`${where}: create needs a triage`);
  if (step.trap_status && !TRAP.includes(step.trap_status)) fail(`${where}: trap_status must be one of ${TRAP}`);
  if (step.action === 'access' && !step.trap_status) fail(`${where}: access needs trap_status`);
  if (step.action === 'tourniquet' && !LIMBS.includes(step.limb)) fail(`${where}: limb must be one of ${LIMBS}`);
  if (step.action === 'tourniquet' && step.clinical_context && !TQ_CONTEXTS.includes(step.clinical_context)) fail(`${where}: clinical_context must be one of ${TQ_CONTEXTS}`);
  if (step.action === 'status' && !STATUSES.includes(step.status)) fail(`${where}: status must be one of ${STATUSES}`);
  if (step.action === 'vitals' && !v) fail(`${where}: vitals action needs vitals`);
}

function loadScenario(file) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`cannot read scenario ${file}: ${e.message}`); }
  if (!s.id || !s.actors || !Array.isArray(s.timeline)) fail('scenario needs id, actors and timeline');
  if (s.synthetic !== true) fail('scenario must declare "synthetic": true (synthetic data only)');
  const created = new Set();
  const timeline = s.timeline.map((st, i) => ({ ...st, atMs: parseTime(st.at, `timeline[${i}]`) }))
    .sort((x, y) => x.atMs - y.atMs);
  timeline.forEach((st, i) => validateStep(st, `timeline[${i}] (${st.at})`, s, created));
  const injects = {};
  for (const [name, inj] of Object.entries(s.injects || {})) {
    const steps = (inj.steps || []).map((st, i) => ({ ...st, afterMs: parseTime(st.after || '0:00', `injects.${name}[${i}]`) }))
      .sort((x, y) => x.afterMs - y.afterMs);
    const c2 = new Set(created); // injects may use timeline patients and create their own
    steps.forEach((st, i) => validateStep(st, `injects.${name}[${i}]`, s, c2));
    injects[name] = { description: inj.description || '', steps };
  }
  return { ...s, timeline, injects };
}

// ---------------------------------------------------------------------------------------------
// Network (all through public endpoints a real device uses)
// ---------------------------------------------------------------------------------------------
async function http(url, opts) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!resp.ok) throw new Error(`${opts.method || 'GET'} ${url.replace(/\?.*/, '')} -> ${resp.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}
class Medic {
  constructor(key, label, ctx) { this.key = key; this.label = label; this.ctx = ctx; this.deviceId = `injector-${key}-${ctx.runId}`; this.silent = false; this.seq = 0; }
  headers() { return { apikey: ANON_KEY, Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }; }
  async signIn(email, password) {
    const r = await http(`${this.ctx.baseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    this.setSession(r);
    const prof = await http(`${this.ctx.baseUrl}/rest/v1/profiles?id=eq.${this.userId}&select=role,is_active`, { headers: this.headers() });
    const p = Array.isArray(prof) ? prof[0] : null;
    if (!p || !p.is_active) fail(`${this.key}: account has no active profile`);
    if (!['medic', 'paramedic'].includes(p.role)) fail(`${this.key}: account role is ${p.role}; virtual medics must be medic or paramedic accounts`);
    this.role = p.role;
  }
  setSession(r) { this.token = r.access_token; this.refreshToken = r.refresh_token; this.userId = r.user && r.user.id; this.expiresAt = Date.now() + (r.expires_in || 3600) * 1000; }
  async ensureFresh() {
    if (Date.now() < this.expiresAt - 120000) return;
    const r = await http(`${this.ctx.baseUrl}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: this.refreshToken }) });
    this.setSession(r);
  }
  async rpc(name, params) {
    await this.ensureFresh();
    return http(`${this.ctx.baseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(params) });
  }
  async heartbeat() {
    if (this.silent) return;
    await this.ensureFresh();
    await http(`${this.ctx.baseUrl}/rest/v1/device_presence?on_conflict=incident_id,actor_id,device_id`, {
      method: 'POST',
      headers: { ...this.headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ incident_id: this.ctx.incidentId, actor_id: this.userId, device_id: this.deviceId, last_heartbeat_at: new Date().toISOString(), sync_status: 'online' }),
    });
  }
  async push(events) {
    await this.ensureFresh();
    return http(`${this.ctx.baseUrl}/functions/v1/sync-log`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ device_id: this.deviceId, incident_id: this.ctx.incidentId, events }),
    });
  }
  nextLocalId() { this.seq += 1; return `inj-${this.ctx.runId}-${this.key}-${String(this.seq).padStart(4, '0')}`; }
}

// ---------------------------------------------------------------------------------------------
// Step -> sync events, using the exact payload keys the server projections read
// (project_patient_state, project_tourniquet_events) and the real client sends.
// ---------------------------------------------------------------------------------------------
function buildEvents(step, ctx, medic) {
  const now = new Date().toISOString();
  const tag = { synthetic_source: 'injector', scenario_id: ctx.scenario.id, run_id: ctx.runId };
  const pid = step.patient ? ctx.patientIds[step.patient] : null;
  const ev = (type, payload, extra = {}) => ({ local_event_id: medic.nextLocalId(), type, patient_id: pid, local_timestamp: now, payload_json: { ...payload, ...tag, ...(pid ? { patient_id: pid } : {}) }, ...extra });
  const vitalsEv = (v) => ev('VITALS_RECORDED', { pulse: v.pulse, rr: v.rr, spo2: v.spo2 ?? null, avpu: v.avpu, bp_estimate: v.bp_estimate || null });
  switch (step.action) {
    case 'create': {
      const out = [ev('QUICK_PATIENT_CREATED', { visual_id: ctx.visualPrefix + step.patient, triage: step.triage, phase: 'mstart_sweep' })];
      // The real client keeps triage only locally today (see scenarios/README.md); the server
      // projection only sets current_triage from PATIENT_TRIAGE_UPDATED, so send it explicitly.
      out.push(step.triage === 'black'
        ? ev('PATIENT_TRIAGED_EXPECTANT', { current_triage: 'black', reason: step.note || 'synthetic expectant' })
        : ev('PATIENT_TRIAGE_UPDATED', { triage: step.triage, algorithm_triage: step.triage }));
      if (step.trap_status) out.push(ev('PATIENT_ACCESS_UPDATED', { trap_status: step.trap_status, access_status: step.trap_status === 'trapped' ? 'trapped' : 'free' }));
      if (step.vitals) out.push(vitalsEv(step.vitals));
      return out;
    }
    case 'vitals': {
      const out = [vitalsEv(step.vitals)];
      if (step.triage) out.push(ev('PATIENT_TRIAGE_UPDATED', { triage: step.triage }));
      return out;
    }
    case 'triage': return [ev('PATIENT_TRIAGE_UPDATED', { triage: step.triage })];
    case 'access': return [ev('PATIENT_ACCESS_UPDATED', { trap_status: step.trap_status, access_status: step.trap_status === 'trapped' ? 'trapped' : 'free' })];
    case 'tourniquet': {
      const applied = new Date(Date.now() + (step.applied_offset_minutes || 0) * 60000).toISOString();
      return [ev('TOURNIQUET_APPLIED', { tourniquet_id: step.tourniquet_id || 'TQ-001', limb: step.limb, application_time: applied, clinical_context: step.clinical_context || 'unknown' })];
    }
    case 'status': return [ev('PATIENT_STATUS_UPDATED', { status: step.status })];
    case 'handover': return [ev('PATIENT_HANDED_OVER', { handover_method: 'mist_logged_local', receiving_unit_transport: step.receiving_unit_transport || 'pending', destination_facility: step.destination_facility || null })];
    case 'expectant': return [ev('PATIENT_TRIAGED_EXPECTANT', { current_triage: 'black', reason: step.note || 'synthetic expectant' })];
    default: return [];
  }
}

function describe(step) {
  const who = step.actor;
  if (step.action === 'note') return `${who}: ${step.note}`;
  if (step.action === 'silence') return `${who}: goes silent (heartbeats stop)`;
  if (step.action === 'resume') return `${who}: back online (heartbeats resume)`;
  const bits = [step.triage, step.trap_status, step.limb, step.status, step.vitals && `HR ${step.vitals.pulse} RR ${step.vitals.rr} SpO2 ${step.vitals.spo2 ?? '-'} ${step.vitals.avpu}`].filter(Boolean);
  return `${who}: ${step.action} ${step.patient}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`;
}

async function runStep(step, ctx) {
  const medic = ctx.medics[step.actor];
  const line = describe(step);
  if (ctx.dryRun) return;
  if (step.action === 'note') { console.log(`   note  ${line}`); return; }
  if (step.action === 'silence') { medic.silent = true; console.log(`   ok    ${line}`); return; }
  if (step.action === 'resume') { medic.silent = false; await medic.heartbeat().catch(() => {}); console.log(`   ok    ${line}`); return; }
  const events = buildEvents(step, ctx, medic);
  try {
    const r = await medic.push(events);
    const acc = (r.accepted || []).length + (r.duplicates || []).length;
    const rej = r.rejected || [];
    const blocked = r.blocked_dependency || [];
    console.log(`   ${rej.length || blocked.length ? 'WARN' : 'ok  '}  ${line}  [${acc}/${events.length} accepted${rej.length ? ', rejected: ' + rej.map((x) => x.error_code).join(',') : ''}${blocked.length ? ', blocked: ' + blocked.length : ''}]`);
  } catch (e) {
    console.log(`   FAIL  ${line}  ${e.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenario = loadScenario(args.scenario);
  const runId = crypto.randomBytes(3).toString('hex');
  const ctx = { scenario, runId, baseUrl: args.baseUrl, dryRun: !!args.dryRun, visualPrefix: args.visualPrefix, medics: {}, patientIds: {} };

  const scheduled = args.inject.map((spec) => {
    const [name, at] = spec.split('@');
    if (!scenario.injects[name]) fail(`--inject ${spec}: no inject named "${name}"`);
    return { name, atMs: parseTime(at || '0:00', `--inject ${spec}`) };
  });

  console.log(`Scenario ${scenario.id}: ${scenario.title || ''}`);
  console.log(`  ${scenario.timeline.length} timeline steps, ${Object.keys(scenario.injects).length} injects, speed x${args.speed}, run ${runId}`);
  if (args.dryRun) {
    scenario.timeline.forEach((st) => console.log(`  ${fmt(st.atMs).padStart(6)}  ${describe(st)}`));
    for (const [name, inj] of Object.entries(scenario.injects)) {
      console.log(`  inject "${name}": ${inj.description}`);
      inj.steps.forEach((st) => console.log(`      +${fmt(st.afterMs)}  ${describe(st)}`));
    }
    console.log('Dry run: scenario is valid. No network calls made.');
    return;
  }

  let accounts;
  try { accounts = JSON.parse(fs.readFileSync(args.accounts, 'utf8')); } catch (e) { fail(`cannot read accounts file: ${e.message}`); }
  for (const [key, actor] of Object.entries(scenario.actors)) {
    const acc = accounts[key];
    if (!acc || !acc.email || !acc.password) fail(`accounts file has no email/password for actor "${key}"`);
    const m = new Medic(key, actor.label || key, ctx);
    await m.signIn(acc.email, acc.password);
    ctx.medics[key] = m;
    console.log(`  signed in ${key} (${m.role})`);
  }
  // Patient UUIDs are generated per run, like a real device's newUuid().
  const allSteps = [...scenario.timeline, ...Object.values(scenario.injects).flatMap((i) => i.steps)];
  for (const st of allSteps) if (st.action === 'create') ctx.patientIds[st.patient] = crypto.randomUUID();

  const actorKeys = Object.keys(ctx.medics);
  if (args.openDraft) {
    const opener = ctx.medics[actorKeys[0]];
    const id = crypto.randomUUID();
    const inc = scenario.incident || {};
    const r = await opener.rpc('open_incident', { p_incident_id: id, p_location_name: inc.location_name || `Synthetic ${scenario.id}`, p_address: inc.address || null, p_incident_type: inc.incident_type || null, p_device_id: opener.deviceId, p_local_event_id: `incident-open-${id}` });
    ctx.incidentId = r.id;
    console.log(`  ${opener.key} opened draft incident ${r.visual_id} (${r.id}) - waiting for command to confirm it in the app`);
    for (const k of actorKeys.slice(1)) await ctx.medics[k].rpc('join_incident', { p_incident_id: ctx.incidentId });
  } else {
    ctx.incidentId = args.join;
    for (const k of actorKeys) await ctx.medics[k].rpc('join_incident', { p_incident_id: ctx.incidentId });
    console.log(`  joined incident ${ctx.incidentId}`);
  }
  await Promise.all(actorKeys.map((k) => ctx.medics[k].heartbeat()));
  const hb = setInterval(() => actorKeys.forEach((k) => ctx.medics[k].heartbeat().catch((e) => console.log(`   hb fail ${k}: ${e.message}`))), HEARTBEAT_MS);

  // Single ordered queue: timeline steps, pre-scheduled injects and live injects all go through
  // it, so two steps for the same patient can never race each other.
  const start = Date.now();
  const elapsed = () => (Date.now() - start) * args.speed;
  const queue = scenario.timeline.map((st) => ({ dueMs: st.atMs, step: st }));
  const addInject = (name, baseMs) => {
    const inj = scenario.injects[name];
    inj.steps.forEach((st) => queue.push({ dueMs: baseMs + st.afterMs, step: st }));
    queue.sort((x, y) => x.dueMs - y.dueMs);
    console.log(` [${fmt(elapsed())}] inject "${name}" scheduled: ${inj.description}`);
  };
  scheduled.forEach((s) => addInject(s.name, s.atMs));
  queue.sort((x, y) => x.dueMs - y.dueMs);

  let quitting = false;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (raw) => {
    const cmd = raw.trim();
    if (!cmd) return;
    if (cmd === 'quit') { quitting = true; return; }
    if (cmd === 'list') { Object.entries(scenario.injects).forEach(([n, i]) => console.log(`   ${n}: ${i.description}`)); return; }
    if (cmd === 'status') { console.log(`   t=${fmt(elapsed())}, ${queue.length} steps pending, incident ${ctx.incidentId}`); return; }
    if (scenario.injects[cmd]) { addInject(cmd, elapsed()); return; }
    console.log(`   unknown command "${cmd}" (inject names: ${Object.keys(scenario.injects).join(', ')}; or list/status/quit)`);
  });

  console.log(`Running. Type an inject name, list, status or quit.`);
  let announcedDone = false;
  while (!quitting) {
    if (queue.length && queue[0].dueMs <= elapsed()) {
      const { step } = queue.shift();
      process.stdout.write(` [${fmt(elapsed())}]`);
      await runStep(step, ctx);
      continue;
    }
    if (!queue.length && !announcedDone) {
      announcedDone = true;
      console.log(` [${fmt(elapsed())}] timeline complete. Virtual medics stay online; fire injects or type quit.`);
      if (!process.stdin.isTTY) quitting = true; // non-interactive run (piped/CI): stop when the queue is empty
    }
    if (queue.length) announcedDone = false;
    await new Promise((r) => setTimeout(r, 200));
  }
  clearInterval(hb);
  rl.close();
  console.log(`Stopped. Incident ${ctx.incidentId}, run ${runId}. Injected events carry synthetic_source=injector, run_id=${runId}.`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
// Exported for scripts/test_inject_scenario.js (offline harness); not a public API.
module.exports = { loadScenario, buildEvents, Medic };
