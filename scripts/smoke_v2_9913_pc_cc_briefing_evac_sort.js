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
  const commanderHeader = section(html, '<div id="screen-commander" class="screen">', '<div class="demo-strip">');
  const cmdContentFn = section(html, 'function renderCmdContent(){', 'function renderCmdPatients(){');
  const pcBoardFn = section(html, 'function renderDedicatedPcCommandBoard(myPts){', 'function renderPcPatientTile(');
  const evacRankFn = section(html, 'function evacuationPriorityRank(p){', 'function companyEvacuationPriorityRows(pts=patients){');

  assert(html.includes("const APP_VERSION = '2.99.16';"), `${rel}: APP_VERSION must be V2.9916`);
  assert(html.includes('Demo V2.9916'), `${rel}: launcher label must be Demo V2.9916`);
  assert(html.includes('ROLE // V2.9916'), `${rel}: role header must be Demo V2.9916`);
  assert(html.includes('Role-Based Medical Command System V2.9916'), `${rel}: role system strip must be Demo V2.9916`);

  // Role Briefing on the shared PC/CC/chamal commander header, dynamic on commandRole
  assert(commanderHeader.includes('onclick="openRoleBriefing(commandRole)"'), `${rel}: commander header briefing button must target the live commandRole, not a hardcoded role`);
  assert(commanderHeader.includes('id="cmd-briefing-badge"'), `${rel}: commander header must have a briefing badge`);
  assert(html.includes('function updateCmdBriefingBadge(){'), `${rel}: updateCmdBriefingBadge missing`);
  assert(html.includes("commandRole==='cc' ? DecisionSupportEngine.forCc() : commandRole==='pc' ? DecisionSupportEngine.forPc()"), `${rel}: cmd briefing badge must branch on commandRole using the existing forCc/forPc, not a new engine`);
  assert(cmdContentFn.includes('updateCmdBriefingBadge();'), `${rel}: renderCmdContent must refresh the briefing badge on every render`);

  // Evacuation-priority ranking extracted from the existing companyEvacuationPriorityRows,
  // behavior-preserving, now reused as a full-list sort for PC/CC patient tile grids.
  assert(evacRankFn.includes("if(tqMin!==null && tqRemaining<45){ rank=0;"), `${rel}: evacuationPriorityRank must keep the exact original tourniquet-window-first ranking`);
  assert(html.includes('function sortedPatientsByEvacPriority(list=patients){'), `${rel}: sortedPatientsByEvacPriority missing`);
  assert(html.includes("const EVAC_COLOR_ORDER = {red:0, yellow:1, green:2, black:3, pending:4, unknown:4};"), `${rel}: evac sort's routine-tier fallback must still be triage-color ordered`);

  assert(pcBoardFn.includes('sortedPatientsByEvacPriority(myPts)'), `${rel}: PC's own patient tile grid must use the evac-priority sort`);
  assert(html.includes("sortedPatientsByEvacPriority(pts).map(p=>renderPcPatientTile(p))"), `${rel}: PC command-view patient table must use the evac-priority sort`);
  assert(html.includes('list=sortedPatientsByEvacPriority(list);'), `${rel}: CC/chamal command patient table must use the evac-priority sort instead of its old ad hoc color/deterioration sort`);

  // companyEvacuationPriorityRows (the existing CC "evac priority" highlight panel) must be
  // unaffected in behavior by the refactor - same ranks, same reasons, same top-8 slice.
  assert(html.includes("rows.sort((a,b)=>a.evacRank-b.evacRank || ((b.tqMin||0)-(a.tqMin||0)));"), `${rel}: companyEvacuationPriorityRows sort must be unchanged`);
  assert(html.includes('rows.slice(0,8)'), `${rel}: companyEvacuationPriorityRows must still cap at 8`);

  console.log(`${rel}: Demo V2.9916 PC/CC role briefing + evac-priority sort static smoke passed`);
}
