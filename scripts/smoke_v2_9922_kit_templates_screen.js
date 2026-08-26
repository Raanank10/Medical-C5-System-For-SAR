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

  assert(html.includes("const APP_VERSION = '2.99.22';"), `${rel}: APP_VERSION must be V2.9922`);
  assert(html.includes('Demo V2.9922'), `${rel}: launcher label must be Demo V2.9922`);
  assert(html.includes('ROLE // V2.9922'), `${rel}: role header must be Demo V2.9922`);
  assert(html.includes('Role-Based Medical Command System V2.9922'), `${rel}: role system strip must be Demo V2.9922`);

  // PR3 of the kit-templates scope: a standalone management screen. kit_templates/
  // kit_template_items (database/001) are plain reference tables, not event-sourced - direct
  // supabase-js CRUD is correct here (RLS, database/005/036, is the real enforcement), unlike
  // supply_requests' event-projection pattern.
  assert(html.includes('id="screen-kit-templates"'), `${rel}: kit-templates screen must exist`);
  assert(html.includes("async function pullKitTemplates()"), `${rel}: pullKitTemplates() must exist`);
  assert(html.includes("client.from('kit_templates')") && html.includes("client.from('kit_template_items')") && html.includes("client.from('inventory_items')"), `${rel}: pullKitTemplates must read all three real tables`);
  assert(/setInterval\(\(\)=>\{ if\(currentUser\) pullKitTemplates\(\); \}, 45000\)/.test(html), `${rel}: must poll on the same 45s cadence as the other real reads`);

  // Role gate: pc/cc/logistics_officer/admin, matching AUTH_MATRIX/database/036 - physician
  // deliberately excluded per explicit product direction.
  assert(html.includes("function canManageKitTemplates()"), `${rel}: canManageKitTemplates() must exist`);
  assert(/canManageKitTemplates\(\)\{[\s\S]{0,120}?\['pc','cc','logistics_officer','admin'\]/.test(html), `${rel}: manage gate must be exactly pc/cc/logistics_officer/admin`);
  assert(!/canManageKitTemplates\(\)\{[\s\S]{0,160}?physician/.test(html), `${rel}: physician must NOT be in the kit-template manage gate`);

  // Incident-status gate (database/037): fail-safe (locked) when status is unknown, unlocked
  // only for a known non-active status.
  assert(html.includes('function kitTemplatesEditLocked()'), `${rel}: kitTemplatesEditLocked() must exist`);
  assert(/kitTemplatesEditLocked\(\)\{[\s\S]{0,200}?return !status \|\| status==='active'/.test(html), `${rel}: lock must default true (fail-safe) when status is unknown, and lock only for 'active'`);
  assert(html.includes("_remoteCommandState[SITE_TO_INCIDENT_ID[currentSiteId()]]?.status"), `${rel}: must read the real server-side incident status, not local siteData.incidentStatus`);

  // Defense-in-depth: write paths re-check both gates, not just the UI disabled state.
  assert(/showKitTemplateModal\(templateId=null\)\{\s*if\(!canManageKitTemplates\(\)\)/.test(html), `${rel}: showKitTemplateModal must re-check the manage gate`);
  assert(/showKitTemplateModal\(templateId=null\)\{[\s\S]{0,200}?if\(kitTemplatesEditLocked\(\)\)/.test(html), `${rel}: showKitTemplateModal must re-check the lock gate`);
  assert(/submitKitTemplate\(\)\{\s*if\(!canManageKitTemplates\(\) \|\| kitTemplatesEditLocked\(\)\) return;/.test(html), `${rel}: submitKitTemplate must re-check both gates before writing`);

  // Item resolution goes through client_item_key (database/035), not a duplicated vocabulary.
  assert(html.includes("cat.client_item_key") || html.includes('item.client_item_key'), `${rel}: item display/save must resolve via client_item_key`);

  // Reachable from both eligible screens.
  assert(html.includes('id="logistics-kit-templates-link"') && html.includes("goTo('kit-templates')"), `${rel}: logistics screen must link to kit templates`);
  assert(/renderRealSupplyQueueRoleSection\(incidentId\)\{[\s\S]*?goTo\('kit-templates'\)/.test(html), `${rel}: pc/cc's shared real-queue section must also link to kit templates`);

  // Screen routing wired into both goTo() and refreshActiveScreenData().
  assert(html.includes("if(screen==='kit-templates') renderKitTemplates();"), `${rel}: goTo() must route to renderKitTemplates()`);
  assert(html.includes("else if(screen==='kit-templates') renderKitTemplates();"), `${rel}: refreshActiveScreenData() must route to renderKitTemplates()`);

  console.log(`${rel}: Demo V2.9922 kit-templates screen smoke passed`);
}
