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

  assert(html.includes("const APP_VERSION = '2.99.21';"), `${rel}: APP_VERSION must be V2.9921`);
  assert(html.includes('Demo V2.9921'), `${rel}: launcher label must be Demo V2.9921`);
  assert(html.includes('ROLE // V2.9921'), `${rel}: role header must be Demo V2.9921`);
  assert(html.includes('Role-Based Medical Command System V2.9921'), `${rel}: role system strip must be Demo V2.9921`);

  // PR4 of the resupply queue/dispatch scope: evaluateSupplyBurn() already computed real
  // burn-rate/stockout predictions from real SUPPLY_CONSUMED events and already fed
  // forPc()/forCc(), but never surfaced on the Logistics Hub screen itself - the role the
  // spec (C5_SENTINEL_SAR_MVP_SPEC_v1.2.md §5.6 "Burn rate by item") actually assigns this
  // to. forLogistics() is the missing role-scoped view onto the existing computation, not a
  // new one - assert it reuses evaluateSupplyBurn/rank rather than reimplementing anything.
  assert(html.includes('function forLogistics()'), `${rel}: DecisionSupportEngine.forLogistics() must exist`);
  assert(/function forLogistics\(\)\{[\s\S]{0,200}?evaluateSupplyBurn\(ctx\)/.test(html), `${rel}: forLogistics() must reuse evaluateSupplyBurn(), not reimplement burn-rate logic`);
  assert(html.includes('forPc,forCc,forMedic,forLogistics,evaluateTourniquets'), `${rel}: forLogistics must be exported from DecisionSupportEngine`);

  // Wired into both the dedicated Logistics Hub screen and the generic role-briefing screen.
  assert(html.includes('id="logistics-burn-predictions"'), `${rel}: logistics screen must have a burn-predictions container`);
  assert(html.includes("DecisionSupportEngine.forLogistics().recommendations") && html.includes("document.getElementById('logistics-burn-predictions')"), `${rel}: renderLogisticsOfficer must populate the burn-predictions container from forLogistics()`);
  assert(html.includes("role==='logistics' ? DecisionSupportEngine.forLogistics()"), `${rel}: renderRoleBriefingBody must route the logistics role to forLogistics()`);

  // Real bug this PR would otherwise reintroduce: acknowledging a recommendation on the
  // logistics screen must actually re-render it, same as it already does for role-dashboard
  // and commander screens - without this the ACK button silently goes stale until the next
  // 45s poll or a screen change.
  assert(/acknowledgeRecommendation\(id\)\{[\s\S]*?document\.getElementById\('screen-logistics'\)\?\.classList\.contains\('active'\)\) renderLogisticsOfficer\(\)/.test(html), `${rel}: acknowledgeRecommendation must re-render the logistics screen when active`);

  console.log(`${rel}: Demo V2.9921 logistics burn-prediction panel smoke passed`);
}
