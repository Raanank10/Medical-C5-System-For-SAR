const fs = require('fs');
const path = require('path');
const { assertVersionLabels } = require('./lib/smoke_version');

const root = path.resolve(__dirname, '..');
const files = ['index.html'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');

  assertVersionLabels(html, rel);

  // The 60-second PC/CC briefing is back, but sandboxed: the phone shares one live database with
  // every other test phone, so nothing the scripted demo creates may persist or reach the server.
  assert(html.includes('onclick="startBriefingDemo()"'), `${rel}: briefing demo button must exist`);
  assert(html.includes('function getSupabaseClient(){\n  if(_demoSandbox) return null;'), `${rel}: no Supabase client (no reads/writes) while the sandbox is open`);
  assert(html.includes('function saveDemoState(){\n  if(_demoSandbox) return Promise.resolve();'), `${rel}: saveDemoState must be a no-op in the sandbox`);
  assert(html.includes('function saveActiveRecoveryState(screen=null){\n  if(_demoSandbox) return Promise.resolve();'), `${rel}: recovery state must not be written in the sandbox`);
  assert(html.includes("  if(_demoSandbox) return; // sandboxed demo events never reach the outbox\n  saveActiveRecoveryState(activeScreenId());"), `${rel}: sandbox events must never reach the outbox`);
  assert(/function startBriefingDemo\(\)\{[\s\S]{0,200}?snapshot:snapshotSandboxState\(\)/.test(html), `${rel}: the demo must snapshot state before touching it`);
  assert(/function endBriefingDemo\(\)\{[\s\S]{0,300}?timers\.forEach\(clearTimeout\);[\s\S]{0,80}?restoreSandboxState\(snapshot\);/.test(html), `${rel}: ending the demo must cancel steps and restore the snapshot`);
  assert(!/function startBriefingDemo\(\)\{[\s\S]{0,3000}?clearDemoScenario\(/.test(html), `${rel}: the demo must never wipe real local data (the old sequence did)`);
  assert(html.includes('id="demo-sandbox-banner"'), `${rel}: a visible sandbox banner must exist`);
  // A sheet a demo step popped (e.g. the tourniquet's supply sheet) must never survive the restore,
  // or a tap on it would write supply events about a demo patient into the real outbox.
  assert(/_demoSandbox=null;\s*closeAllOpenModals\(\);\s*restoreSandboxState\(snapshot\);/.test(html), `${rel}: ending the demo must close every open modal before restoring`);

  // Guided tour: read-only walkthrough of the real PC/CC dashboards.
  assert(html.includes('onclick="startGuidedTour()"'), `${rel}: guided tour button must exist`);
  assert(html.includes('const GUIDED_TOUR_STEPS = ['), `${rel}: guided tour steps must exist`);
  assert(html.includes('id="guided-tour-card"'), `${rel}: guided tour card must exist`);
  assert(/function startGuidedTour\(\)\{\s*if\(_demoSandbox\)/.test(html), `${rel}: the tour must not start inside the sandboxed demo`);

  console.log(`${rel}: Demo V2.9925 sandboxed briefing + guided tour smoke passed`);
}
