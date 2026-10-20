// Shared by scripts/smoke_*.js. Each smoke script used to pin the APP_VERSION it shipped with, so
// every later release made all of them fail. They now check only that the three visible version
// labels agree with whatever APP_VERSION currently is (CLAUDE.md: bump them together).
// scripts/check_repo.py runs the same check in CI.

function versionLabel(appVersion) {
  // '2.99.41' -> 'V2.9941', matching the existing "Demo V2.9941" label style.
  const [major, minor, patch] = appVersion.split('.');
  return `V${major}.${minor}${patch}`;
}

function assertVersionLabels(html, rel) {
  const match = html.match(/const APP_VERSION = '(\d+\.\d+\.\d+)';/);
  if (!match) throw new Error(`${rel}: APP_VERSION declaration missing`);
  const label = versionLabel(match[1]);
  [`Demo ${label}`, `ROLE // ${label}`, `Role-Based Medical Command System ${label}`].forEach(s => {
    if (!html.includes(s)) throw new Error(`${rel}: visible label must be "${s}" to match APP_VERSION ${match[1]}`);
  });
}

module.exports = { versionLabel, assertVersionLabels };
