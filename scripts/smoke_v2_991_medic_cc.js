const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  path.join(root, 'index.html'),
  path.join(root, 'demo', 'rescue-app.html')
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of files) {
  const rel = path.relative(root, file);
  const html = fs.readFileSync(file, 'utf8');
  const sweepStart = html.indexOf('const limbLabels=');
  const sweepEnd = html.indexOf('function timeCodeToTodayMs', sweepStart);
  const sweep = html.slice(sweepStart, sweepEnd);
  const ccStart = html.indexOf('function renderCcHeroDashboard');
  const ccEnd = html.indexOf('function renderCcCommandBoard', ccStart);
  const ccHero = html.slice(ccStart, ccEnd);

  assert(html.includes("const APP_VERSION = '2.99.9';"), `${rel}: APP_VERSION must be V2.999`);
  assert(html.includes('Demo V2.999'), `${rel}: launcher label must be V2.999`);
  assert(html.includes('ROLE // V2.999'), `${rel}: role label must be V2.999`);
  assert(!html.includes('Demo V3.0') && !html.includes("const APP_VERSION = '3.0.0';"), `${rel}: V3.0 must not be present`);

  assert(sweep.includes('${triageBand(p.triage,p)}'), `${rel}: top triage band removed`);
  assert(sweep.includes('M — דימום מסכן חיים'), `${rel}: M hemorrhage block missing`);
  assert(sweep.includes("${btn('breathing','yes','נושם')}") && sweep.includes("${btn('breathing','no','לא נושם','triage-black')}"), `${rel}: primary breathing yes/no buttons missing`);
  assert(!sweep.includes("${btn('breathing','unsure'"), `${rel}: visible breathing unsure button remains`);
  assert(!sweep.includes("setBreathingAfterAirway('unsure')"), `${rel}: visible post-airway unsure button remains`);
  assert(!sweep.includes("${btn('trapped','unknown'"), `${rel}: visible trapped unknown button remains`);
  assert(sweep.includes("setSweepMstartField(null,'trapped','access_blocked')"), `${rel}: access blocked secondary action missing`);
  assert(sweep.indexOf('חסמי עורקים / שליטה בדימום') > sweep.indexOf('ניידות / לכוד'), `${rel}: TQ cards should render after mobility`);
  assert(sweep.includes('פצוע הבא') && sweep.includes('סיים סריקה'), `${rel}: sticky next/finish sweep actions missing`);
  assert(html.includes("p.mstart.breathing='assumed_yes'"), `${rel}: AVPU assumed breathing path missing`);
  assert(html.includes("p.mstart.breathing==='no'"), `${rel}: AVPU contradiction guard missing`);

  assert(ccHero.includes('מ״פ רפואה — החלטות עכשיו'), `${rel}: CC hero title missing`);
  assert(ccHero.includes('מה להזיז, לאן, ולמה'), `${rel}: CC hero subtitle missing`);
  assert(ccHero.includes('העבר חובש') && ccHero.includes('שייך רופא / פראמדיק'), `${rel}: CC hero resource/doctor cards missing`);
  assert(ccHero.includes('צוואר בקבוק פינוי') && ccHero.includes('ציוד שמשפיע על טיפול'), `${rel}: CC hero bottleneck cards missing`);
  assert(html.includes('function renderCcPlatoonPanel('), `${rel}: CC platoon panel renderer missing`);
  assert(ccHero.includes('class="panel-grid"') && ccHero.includes('platoonPanels'), `${rel}: CC hero must render per-platoon panels`);
  assert(html.includes('${renderCcHeroDashboard({openReqs,doctorReqs,deathReqs,blockedEvac,overloaded,ineffectiveTqs,tqPatients})}'), `${rel}: CC hero not rendered at top of CC board`);

  assert(html.includes('LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS'), `${rel}: legacy guard comment missing`);
  assert(html.includes('function startNewPatient('), `${rel}: legacy startNewPatient removed`);
  for (let i = 1; i <= 8; i++) {
    assert(html.includes(`id="screen-step${i}"`), `${rel}: legacy screen-step${i} removed`);
  }
  assert(html.includes('function renderPcNowTaskBoard'), `${rel}: PC task board missing`);
  assert(html.includes('function renderLogisticsOfficer'), `${rel}: logistics renderer missing`);
  assert(html.includes('function renderAar'), `${rel}: AAR renderer missing`);
  assert(html.includes('function confirmSuspectedNotSalvageable'), `${rel}: black/death-cert flow missing`);

  console.log(`${rel}: V2.999 medic speed + CC hero static smoke passed`);
}
