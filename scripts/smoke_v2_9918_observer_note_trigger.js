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

  assert(html.includes("const APP_VERSION = '2.99.18';"), `${rel}: APP_VERSION must be V2.9918`);
  assert(html.includes('Demo V2.9918'), `${rel}: launcher label must be Demo V2.9918`);
  assert(html.includes('ROLE // V2.9918'), `${rel}: role header must be Demo V2.9918`);
  assert(html.includes('Role-Based Medical Command System V2.9918'), `${rel}: role system strip must be Demo V2.9918`);

  // Real bug found and fixed: observer-note-panel existed with a working save/export pipeline
  // but nothing ever opened it (no button set its display away from 'none'). This asserts the
  // fix stays in place - a real trigger calling a real toggle function.
  assert(html.includes('id="observer-note-panel"'), `${rel}: observer-note-panel must still exist`);
  assert(html.includes('onclick="showObserverNote()"'), `${rel}: a button must call showObserverNote() to open the panel`);
  assert(/function showObserverNote\(\)\{[\s\S]{0,200}?panel\.style\.display='block'/.test(html), `${rel}: showObserverNote() must set the panel's display to 'block'`);
  assert(html.includes("function hideObserverNote()"), `${rel}: hideObserverNote() must still exist (cancel path)`);
  assert(html.includes("function saveObserverNote()"), `${rel}: saveObserverNote() must still exist (save path, feeds exportExperimentLog's observer_notes)`);

  console.log(`${rel}: Demo V2.9918 observer-note trigger smoke passed`);
}
