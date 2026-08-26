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
  const heatmapFn = section(html, 'const localState=buildIncidentCommandStateSnapshot(pts, site);', "setCmdPanelMeta('heatmap',");

  assert(html.includes("const APP_VERSION = '2.99.17';"), `${rel}: APP_VERSION must be V2.9917`);
  assert(html.includes('Demo V2.9917'), `${rel}: launcher label must be Demo V2.9917`);
  assert(html.includes('ROLE // V2.9917'), `${rel}: role header must be Demo V2.9917`);
  assert(html.includes('Role-Based Medical Command System V2.9917'), `${rel}: role system strip must be Demo V2.9917`);

  // The sector heatmap must prefer the real server snapshot (incident_command_state.state_json.sectors)
  // when it's available, and only fall back to the locally-computed snapshot otherwise - this is the
  // concrete "shift to primary" change, not a cosmetic relabel.
  assert(heatmapFn.includes('_remoteCommandState[SITE_TO_INCIDENT_ID[site.id]]?.state_json?.sectors'), `${rel}: heatmap must read the real server sector snapshot`);
  assert(heatmapFn.includes("const sectorSource=(remoteSectorsRaw && remoteSectorsRaw.length) ? 'server' : 'local';"), `${rel}: heatmap must pick sectorSource='server' only when real server sector data exists, else fall back to 'local'`);
  assert(heatmapFn.includes('buildIncidentCommandStateSnapshot(pts, site)'), `${rel}: local snapshot must remain as the offline/local-demo fallback`);
  assert(!heatmapFn.includes('incident_command_state cache'), `${rel}: must not keep the old mislabeled "incident_command_state cache" string on locally-computed data`);
  assert(heatmapFn.includes("'incident_command_state (שרת)'"), `${rel}: server-sourced sector rows must be honestly labeled as server data`);

  console.log(`${rel}: Demo V2.9917 command-heatmap server-primary smoke passed`);
}
