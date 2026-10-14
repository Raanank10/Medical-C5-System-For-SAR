// Offline harness for scripts/inject_scenario.js: runs the real injector process against a local
// mock of the Supabase endpoints it uses (auth, profiles, RPCs, device_presence, sync-log) and
// checks the wire traffic. No network, no real accounts. The payload semantics themselves were
// verified separately against the live database triggers (see scenarios/README.md).
// Run: node scripts/test_inject_scenario.js
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }

const USERS = {
  'vm1@test': { id: '11111111-1111-4111-8111-111111111111', role: 'medic' },
  'vm2@test': { id: '22222222-2222-4222-8222-222222222222', role: 'medic' },
};
const log = { rpc: [], heartbeats: [], pushes: [] };
let refused = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const auth = (req.headers.authorization || '').replace('Bearer ', '');
    const user = Object.values(USERS).find((u) => auth === 'tok-' + u.id);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/auth/v1/token') {
      const { email } = JSON.parse(body);
      const u = USERS[email];
      if (!u) return send(400, { error: 'invalid_grant' });
      return send(200, { access_token: 'tok-' + u.id, refresh_token: 'r', expires_in: 3600, user: { id: u.id } });
    }
    if (!user) { refused++; return send(401, { error: 'no auth' }); }
    if (url.pathname === '/rest/v1/profiles') return send(200, [{ role: user.role, is_active: true }]);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop();
      const params = JSON.parse(body || '{}');
      log.rpc.push({ name, user: user.id, params });
      if (name === 'open_incident') return send(200, { id: params.p_incident_id, visual_id: 'INC-TEST', status: 'draft', created: true });
      return send(200, { id: params.p_incident_id });
    }
    if (url.pathname === '/rest/v1/device_presence') { log.heartbeats.push({ user: user.id, ...JSON.parse(body), t: Date.now() }); return send(201); }
    if (url.pathname === '/functions/v1/sync-log') {
      const b = JSON.parse(body);
      log.pushes.push({ user: user.id, ...b });
      return send(200, { accepted: b.events.map((e) => ({ local_event_id: e.local_event_id })), duplicates: [], rejected: [] });
    }
    return send(404, { error: 'unexpected ' + url.pathname });
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-test-'));
  const accounts = path.join(tmp, 'accounts.json');
  fs.writeFileSync(accounts, JSON.stringify({ vm1: { email: 'vm1@test', password: 'x' }, vm2: { email: 'vm2@test', password: 'x' } }));
  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [
    path.join(root, 'scripts', 'inject_scenario.js'),
    '--scenario', path.join(root, 'scenarios', 'small_site_alpha_v1.json'),
    '--accounts', accounts, '--open-draft', '--speed', '600', '--base-url', `http://127.0.0.1:${port}`,
    '--inject', 'deterioration@20:30', '--inject', 'medic_silent@20:40', '--inject', 'medic_back@21:00', '--inject', 'mass_arrival@21:10',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.end();
  const timer = setTimeout(() => { child.kill(); assert(false, 'injector did not finish in time\n' + out); }, 30000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    assert(code === 0, `injector exited with ${code}\n${out}`);
    assert(refused === 0, 'a request was sent without a valid token');
    assert(!/FAIL|WARN/.test(out), 'injector reported a failed or partially rejected step\n' + out);

    const opens = log.rpc.filter((r) => r.name === 'open_incident');
    assert(opens.length === 1 && opens[0].user === USERS['vm1@test'].id, 'exactly one open_incident, by vm1');
    const incidentId = opens[0].params.p_incident_id;
    assert(log.rpc.some((r) => r.name === 'join_incident' && r.user === USERS['vm2@test'].id && r.params.p_incident_id === incidentId), 'vm2 must join the opened incident');

    const events = log.pushes.flatMap((p) => p.events.map((e) => ({ ...e, user: p.user, incident: p.incident_id, device: p.device_id })));
    assert(log.pushes.every((p) => p.incident_id === incidentId), 'every push must target the opened incident');
    assert(events.every((e) => e.payload_json.synthetic_source === 'injector' && e.payload_json.scenario_id === 'small_site_alpha_v1' && e.payload_json.run_id), 'every event must carry the injector tag');
    const ids = new Set(events.map((e) => `${e.device}/${e.local_event_id}`));
    assert(ids.size === events.length, 'local_event_ids must be unique per device');
    assert(events.length === 57, `expected 57 events (timeline + the deterioration and mass_arrival injects), got ${events.length}`);

    // Every patient is created before any other event refers to it.
    const created = new Set();
    for (const e of events) {
      if (e.type === 'QUICK_PATIENT_CREATED') { assert(e.patient_id && e.payload_json.visual_id, 'create needs patient_id and visual_id'); created.add(e.patient_id); }
      else if (e.patient_id) assert(created.has(e.patient_id), `${e.type} sent before its patient was created`);
    }
    assert(created.size === 12, `expected 12 created patients, got ${created.size}`);
    // Triage is sent explicitly (the server only projects it from these two event types).
    for (const pid of created) assert(events.some((e) => e.patient_id === pid && ['PATIENT_TRIAGE_UPDATED', 'PATIENT_TRIAGED_EXPECTANT'].includes(e.type)), 'every created patient needs a triage event');
    // Actor separation: vm2's patients come from vm2's account and device.
    const vm2Creates = events.filter((e) => e.type === 'QUICK_PATIENT_CREATED' && e.user === USERS['vm2@test'].id);
    assert(vm2Creates.length === 6 && vm2Creates.every((e) => e.device.startsWith('injector-vm2-')), 'vm2 creates must come from vm2 account and device');
    // Deterioration inject upgraded S1-04 to red.
    assert(events.some((e) => e.type === 'PATIENT_TRIAGE_UPDATED' && e.payload_json.triage === 'red' && events.find((c) => c.type === 'QUICK_PATIENT_CREATED' && c.patient_id === e.patient_id).payload_json.visual_id === 'S1-04'), 'deterioration inject must set S1-04 red');
    // Heartbeats: both medics at start; vm2 heartbeats again when it comes back.
    const vm2Beats = log.heartbeats.filter((h) => h.user === USERS['vm2@test'].id);
    assert(log.heartbeats.some((h) => h.user === USERS['vm1@test'].id) && vm2Beats.length >= 2, 'heartbeats expected for both medics, and again for vm2 on resume');
    assert(log.heartbeats.every((h) => h.incident_id === incidentId && h.sync_status === 'online'), 'heartbeats must target the incident');
    console.log(`inject_scenario offline harness passed (${events.length} events, ${created.size} patients, ${log.heartbeats.length} heartbeats)`);
  });
});
