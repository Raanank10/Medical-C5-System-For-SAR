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

  assert(html.includes("const APP_VERSION = '2.99.31';"), `${rel}: APP_VERSION must be V2.9931`);
  assert(html.includes('Demo V2.9931'), `${rel}: launcher label must be Demo V2.9931`);
  assert(html.includes('ROLE // V2.9931'), `${rel}: role header must be Demo V2.9931`);
  assert(html.includes('Role-Based Medical Command System V2.9931'), `${rel}: role system strip must be Demo V2.9931`);

  // Handover: optional destination + MDA classification, never the old 'pending' placeholder.
  assert(html.includes(`onclick="openEvacuationSheet('\${p.id}','handover')">הועבר למד״א — עכשיו</button>`), `${rel}: handover button must open the evacuation sheet`);
  assert(!/destination_facility:'pending'|receiving_unit_transport:'pending'/.test(html), `${rel}: no handover may send the 'pending' placeholder`);
  assert(/function evacuationPayload\(destination, mdaClassification\)\{[\s\S]{0,300}?C5Rules\.isValidMdaClassification\(mdaClassification\)/.test(html), `${rel}: only a valid MDA classification may be sent`);

  // Later update: command roles only, synced as PATIENT_EVACUATION_UPDATED.
  assert(html.includes("const EVAC_REPORTING_ROLES = new Set(['pc','cc','chamal','physician','admin']);"), `${rel}: evacuation/report roles must match sync-log`);
  assert(/'PATIENT_DEATH_CONFIRMED',\s*'PATIENT_EVACUATION_UPDATED'\s*\]\);/.test(html), `${rel}: PATIENT_EVACUATION_UPDATED must be sync-eligible`);
  assert(/function updatePatientEvacuation\([\s\S]{0,200}?if\(!canUpdateEvacuationTracking\(\)\)/.test(html), `${rel}: later update must be gated by role`);

  // External reports: United Hatzalah and Yedidim are separate sources, and reports sync.
  assert(html.includes("UH:{label:'איחוד הצלה', server:'united_hatzalah'}") && html.includes("YEDIDIM:{label:'ידידים', server:'yedidim'}"), `${rel}: UH and Yedidim must be separate sources`);
  assert(html.includes(`onclick="selectReportSource(this,'UH')"><span class="icon">🧡</span>איחוד הצלה</button>`), `${rel}: the UH button must read איחוד הצלה`);
  assert((html.match(/selectInitialReportSource\(this,'uh'\)">איחוד הצלה/g) || []).length === 2, `${rel}: initial-evacuation chips must offer איחוד הצלה on both screens`);
  assert(/saveLocalEvent\(\{type:'EXTERNAL_REPORT_CREATED'[\s\S]{0,900}?linked_patient_id/.test(html), `${rel}: reports must sync, with the patient link kept out of events.patient_id`);

  // Board by location on the PC and CC dashboards and the command screen.
  assert(html.includes("${['pc','cc'].includes(role)?roleSection('לוח נפגעים לפי מיקום — מוקד ואזור', renderCasualtyLocationBoard(casualtyBoardSiteIds(role))):''}"), `${rel}: PC and CC role dashboards must show the location board`);
  assert(html.includes('id="cmd-location-board"') && html.includes('locations:true'), `${rel}: command screen must have the location board panel`);
  assert(html.includes("return role==='pc' ? [pcPlatoonSite()] : allSites.filter(s=>s.id!=='ALL').map(s=>s.id);"), `${rel}: board: CC (company) every site, PC (platoon) its own site`);
  assert(html.includes("renderCasualtyLocationBoard(cmdActiveSite==='ALL'?commandVisibleSites().filter(id=>id!=='ALL'):[cmdActiveSite])"), `${rel}: command screen board follows the command scope`);

  // Command hierarchy: PC (platoon) scoped to its platoon's site, CC (company) sees every site.
  assert(html.includes("function commandVisibleSites(){\n  if(commandRole==='pc') return [pcPlatoonSite()];\n  return allSites.map(s=>s.id);"), `${rel}: only the PC is narrowed on the command screen`);
  assert(!html.includes('ccCompanySite'), `${rel}: the CC must no longer be pinned to one site`);
  assert(html.includes("const visible=reinforcementRequests.filter(r=>commandRole!=='pc' || (r.siteId||'SITE_A')===pcPlatoonSite());"), `${rel}: PC sees its own platoon's reinforcement requests, CC all`);
  assert(html.includes("const ctx={...defaultContext(),patients:roleScopedPatients('pc')};"), `${rel}: PC recommendations cover its own platoon only`);
  assert(html.includes("const border=color?`2px solid ${color}`:'2px dashed var(--muted)';"), `${rel}: pending triage must never get a triage colour on the board`);

  // Location now syncs, and new pulls never break the main patient pull.
  assert(/function reconcileLocationSync\(\)\{[\s\S]{0,700}?type:'PATIENT_LOCATION_UPDATED'/.test(html), `${rel}: patient zone must sync`);
  assert(html.includes('pullProjectedPatientState(id); pullPatientLocations(id); pullEvacuationTracking(id); pullExternalReports(id);'), `${rel}: separate pulls for location, evacuation and reports`);
  assert(html.includes("const PROJECTED_PATIENT_COLUMNS = 'id,incident_id,visual_id,current_triage,current_status,access_status,needs_full_assessment,is_pediatric,pediatric_age_years,last_vitals_at,version,optional_name,identifying_description,physician_death_confirmed_at,physician_death_confirmed_by';"), `${rel}: the main patient pull must not depend on database/043 columns`);

  console.log(`${rel}: Demo V2.9931 evacuation tracking + location board smoke passed`);
}
