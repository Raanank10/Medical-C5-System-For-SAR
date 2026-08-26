const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', path.join('demo', 'rescue-app.html')];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function section(html, startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert(start >= 0, `missing section start: ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing section end: ${endNeedle}`);
  return html.slice(start, end);
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const patientScreen = section(html, '<div id="screen-patient" class="screen">', '<!-- ══════════════════════ COMMANDER');
  const saveLocalEventFn = section(html, 'function saveLocalEvent(event){', '// ── Post-event sync confirmation');
  const trackFn = section(html, 'function trackHighStakesSync(entry){', 'function checkHighStakesSyncStatus(');
  const checkFn = section(html, 'function checkHighStakesSyncStatus(localEventId, label){', 'async function retryHighStakesSync(');

  assert(html.includes("const APP_VERSION = '2.99.16';"), `${rel}: APP_VERSION must be V2.9916`);
  assert(html.includes('Demo V2.9916'), `${rel}: launcher label must be Demo V2.9916`);
  assert(html.includes('ROLE // V2.9916'), `${rel}: role header must be Demo V2.9916`);
  assert(html.includes('Role-Based Medical Command System V2.9916'), `${rel}: role system strip must be Demo V2.9916`);

  // Patient detail screen was the one screen missing a live sync indicator - now has one,
  // reusing the same .sync-pill component/fresh-stale-offline styling as every other screen.
  assert(patientScreen.includes('id="sync-pill-detail"'), `${rel}: patient detail header must have a sync-pill`);
  assert(html.includes("'sync-pill-detail'"), `${rel}: updateDemoStatus must refresh the patient-detail sync-pill alongside the existing ones`);
  assert(html.includes('updateDemoStatus();\n  goTo(\'patient\');'), `${rel}: openPatient must refresh sync status immediately on open, not wait for the next 45s tick`);

  // No permanent "Sync Now" button anywhere - only a one-off confirmation on the three
  // highest-stakes clinical events, gated behind currentUser (local-demo mode never pushes).
  assert(html.includes("const HIGH_STAKES_SYNC_EVENT_TYPES = new Set(['TOURNIQUET_APPLIED','PATIENT_TRIAGED_EXPECTANT','PATIENT_HANDED_OVER']);"), `${rel}: high-stakes event set must be exactly tourniquet/black-triage/handover`);
  assert(saveLocalEventFn.includes('trackHighStakesSync(entry);'), `${rel}: saveLocalEvent must invoke the confirmation tracker for every saved event`);
  assert(trackFn.includes('if(!currentUser) return;'), `${rel}: trackHighStakesSync must skip entirely in local-demo (no-login) mode`);
  assert(trackFn.includes("if(!HIGH_STAKES_SYNC_EVENT_TYPES.has(entry.type)) return;"), `${rel}: trackHighStakesSync must only fire for the three high-stakes event types`);
  assert(trackFn.includes("el.className='sync-confirm-toast pending';"), `${rel}: initial toast state must be pending`);

  // Fast path (already synced by the time of the check) reuses toast()'s auto-dismiss pattern;
  // slow path escalates to a persistent chip with a scoped retry (never a global sync button);
  // rejected path is distinct and does not auto-dismiss (needs human review).
  assert(checkFn.includes("if(entry && entry.synced && !entry.syncRejected){") && checkFn.includes("setTimeout(()=>el.remove(),2200);"), `${rel}: successful sync must auto-dismiss like the existing toast()`);
  assert(checkFn.includes('if(entry && entry.syncRejected){') && checkFn.includes("className='sync-confirm-toast rejected';"), `${rel}: a rejected push must render a distinct, non-dismissing state`);
  assert(checkFn.includes('sync-confirm-retry') && checkFn.includes('onclick="retryHighStakesSync('), `${rel}: still-pending state must offer a scoped retry button, not a page-wide sync button`);
  assert(html.includes('async function retryHighStakesSync(localEventId, label){') && html.includes('await syncPush();'), `${rel}: retry must call the real syncPush(), not a fake/local-only stub`);

  // CSS for the new toast stack exists and is visually distinct per state
  assert(html.includes('#sync-confirm-stack{'), `${rel}: sync-confirm-stack container CSS missing`);
  assert(html.includes('.sync-confirm-toast.ok{') && html.includes('.sync-confirm-toast.pending{') && html.includes('.sync-confirm-toast.rejected{'), `${rel}: sync-confirm-toast must style ok/pending/rejected distinctly`);

  console.log(`${rel}: Demo V2.9916 sync confirmation + patient-detail indicator static smoke passed`);
}
