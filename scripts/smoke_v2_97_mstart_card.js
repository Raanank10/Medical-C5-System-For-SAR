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
  const renderStart = html.indexOf('function renderMstartSweep');
  const renderEnd = html.indexOf('function timeCodeToTodayMs', renderStart);
  const renderBody = html.slice(renderStart, renderEnd);
  const treatmentStart = html.indexOf('function recordSweepTreatment');
  const treatmentEnd = html.indexOf('function setSweepTourniquetLimb', treatmentStart);
  const treatmentBody = html.slice(treatmentStart, treatmentEnd);

  assert(html.includes("const APP_VERSION = '2.99.2';"), `${rel}: APP_VERSION must be 2.992V`);
  assert(html.includes('Demo 2.992V'), `${rel}: launcher label must be 2.992V`);
  assert(renderBody.includes('M — דימום מסכן חיים'), `${rel}: missing immediate hemorrhage section`);
  assert(renderBody.indexOf('M — דימום מסכן חיים') < renderBody.indexOf('הולך?'), `${rel}: hemorrhage section must precede walking`);
  const breathingLabel = '<div class="field-label">נשימה</div>';
  const perfusionLabel = '<div class="field-label">פרפוזיה / דופק</div>';
  const avpuLabel = '<div class="field-label">AVPU</div>';
  const mobilityLabel = '<div class="field-label">ניידות / לכוד</div>';
  assert(renderBody.indexOf(breathingLabel) < renderBody.indexOf(perfusionLabel), `${rel}: breathing must precede perfusion`);
  assert(renderBody.indexOf(perfusionLabel) < renderBody.indexOf(avpuLabel), `${rel}: perfusion must precede AVPU`);
  assert(renderBody.indexOf(avpuLabel) < renderBody.indexOf(mobilityLabel), `${rel}: AVPU must precede mobility`);
  assert(!renderBody.includes('<button class="tap-btn triage-red" onclick="recordSweepTreatment(\'airway\')">פתיחת נתיב אוויר</button>'), `${rel}: generic airway button remains in top strip`);
  assert(renderBody.includes('פתח נתיב אוויר / בדוק מחדש'), `${rel}: missing conditional airway action`);
  assert(renderBody.includes('נושם אחרי פתיחת נתיב אוויר?'), `${rel}: missing breathing-after-airway question`);
  assert(!renderBody.includes("${btn('breathing','unsure'"), `${rel}: visible breathing unsure button remains`);
  assert(!renderBody.includes("setBreathingAfterAirway('unsure')"), `${rel}: visible after-airway unsure button remains`);
  assert(!renderBody.includes("${btn('trapped','unknown'"), `${rel}: visible trapped unknown button remains`);
  assert(renderBody.includes("setSweepMstartField(null,'trapped','access_blocked')"), `${rel}: secondary access-blocked path missing`);
  assert(html.includes("if(key==='breathing' && ['no','unsure'].includes(value))"), `${rel}: no/unsure breathing must expose airway prompt`);
  assert(html.includes('ערוך גפה / תקן רישום'), `${rel}: missing inline per-tourniquet limb editor`);
  assert(html.includes("unknown:{label:'לא ידוע'"), `${rel}: missing deferred limb option`);
  assert(renderBody.includes('פציעות / מיקום בגוף / הערכה מורחבת'), `${rel}: missing collapsed extended assessment`);
  assert(renderBody.includes('<details style="margin-top:12px'), `${rel}: extended assessment must be collapsed by default`);
  assert(!treatmentBody.includes("classList.remove('hidden')"), `${rel}: tourniquet treatment still opens blocking limb modal`);
  assert(treatmentBody.includes('silentPopup:true,silentWarnings:true,suppressAutoResupply:true'), `${rel}: silent MSTART supply behavior changed`);
  assert(html.includes('id="tourniquet-limb-modal"'), `${rel}: legacy limb modal removed`);
  assert(html.includes('id="screen-step6"'), `${rel}: legacy body-map screen removed`);
  assert(html.includes('function renderPcNowTaskBoard'), `${rel}: PC board removed`);
  assert(html.includes('function renderCcCommandBoard'), `${rel}: CC board removed`);
  assert(html.includes('function renderAar'), `${rel}: AAR removed`);

  console.log(`${rel}: V2.992 MSTART card static smoke passed`);
}
