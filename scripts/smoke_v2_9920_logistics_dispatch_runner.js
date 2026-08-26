const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', path.join('demo', 'rescue-app.html')];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');

  assert(html.includes("const APP_VERSION = '2.99.20';"), `${rel}: APP_VERSION must be V2.9920`);
  assert(html.includes('Demo V2.9920'), `${rel}: launcher label must be Demo V2.9920`);
  assert(html.includes('ROLE // V2.9920'), `${rel}: role header must be Demo V2.9920`);
  assert(html.includes('Role-Based Medical Command System V2.9920'), `${rel}: role system strip must be Demo V2.9920`);

  // PR3 of the resupply queue/dispatch scope: logistics dispatch/runner-assign write actions
  // on the real supply_requests queue (database/033 + database/034). These write the
  // schema-native SUPPLY_REQUEST_DISPATCHED/IN_TRANSIT/RECEIVED event types, already
  // allow-listed for logistics_officer in supabase/functions/sync-log/index.ts's
  // SUPPLY_LOGISTICS_EVENTS since before this session.
  assert(html.includes('function supplyRequestDispatchActions(r, incidentId)'), `${rel}: supplyRequestDispatchActions() must exist`);
  assert(html.includes('function showDispatchRunnerModal(requestId, incidentId)'), `${rel}: showDispatchRunnerModal() must exist`);
  assert(html.includes('function submitDispatchRunner()'), `${rel}: submitDispatchRunner() must exist`);
  assert(html.includes('function markSupplyRequestInTransit(requestId, incidentId)'), `${rel}: markSupplyRequestInTransit() must exist`);
  assert(html.includes('function markSupplyRequestDelivered(requestId, incidentId)'), `${rel}: markSupplyRequestDelivered() must exist`);
  assert(html.includes('function updateLocalSupplyRequestOptimistic(incidentId, requestId, patch)'), `${rel}: updateLocalSupplyRequestOptimistic() must exist (optimistic local update, no 45s wait for the next pull)`);

  // Real bug found and fixed while building this PR (database/034): the trigger's update path
  // must resolve by the real server-side id, not by (device_id, client-local id) - the
  // dispatching device is essentially never the same device that created the request. Assert
  // the client actually sends that real id rather than a client-local one.
  assert(html.includes("payload_json:{supply_request_id:requestId, runner_name:runnerName, eta_minutes:etaMinutes}"), `${rel}: SUPPLY_REQUEST_DISPATCHED must send the real supply_request_id, not a client-local id`);
  assert(html.includes("type:'SUPPLY_REQUEST_IN_TRANSIT'") && html.includes('payload_json:{supply_request_id:requestId}'), `${rel}: SUPPLY_REQUEST_IN_TRANSIT must send the real supply_request_id`);
  assert(html.includes("type:'SUPPLY_REQUEST_RECEIVED'"), `${rel}: SUPPLY_REQUEST_RECEIVED must be emitted by markSupplyRequestDelivered`);

  // Modal markup exists and is wired (hidden by default, opened/closed correctly).
  assert(html.includes('id="dispatch-runner-modal"') && html.includes('class="modal-overlay hidden" id="dispatch-runner-modal"'), `${rel}: dispatch-runner-modal must exist and start hidden`);
  assert(html.includes('id="dispatch-runner-name"') && html.includes('id="dispatch-runner-eta"'), `${rel}: runner name/ETA inputs must exist`);
  assert(html.includes('onclick="submitDispatchRunner()"'), `${rel}: modal must have a submit action`);
  assert(html.includes('function hideDispatchRunnerModal()') && html.includes('function closeDispatchRunnerModal(e)'), `${rel}: cancel/backdrop-close paths must exist`);

  // The logistics real-queue row rendering must actually call the action-button builder.
  assert(html.includes('supplyRequestDispatchActions(r, realQueueIncidentId)'), `${rel}: renderLogisticsOfficer must render per-row dispatch actions`);

  console.log(`${rel}: Demo V2.9920 logistics dispatch/runner smoke passed`);
}
