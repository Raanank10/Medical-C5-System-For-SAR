// Real-browser test of the unit security scope's client side (database/045, V2.99.33; companies
// and platoons as real units since database/053, V2.99.42): CC, RCC, PC, RPC and medic phones
// share one fake backend in this Node process (same harness as
// scripts/browser_medic_assignment_test.js). The fake enforces the database/053 rules the client
// depends on: a pc / rcc reaches its own company's sites, an rpc its own platoon's, everyone also
// the sites it belongs to; no self-join elsewhere; list_open_incidents scoped; profiles readable by
// a PC only for itself and its own company; memberships written by a PC only for its own
// company's medics; create_company / create_platoon / set_profile_unit for company-level command
// only; set_incident_unit for company-level command and, inside its own company, the rcc. The SQL
// itself is tested by scripts/rls_test_053_platoons.sql (docs/RLS_AUDIT_v1.md, 053 follow-up).
// WP-27 (database/096, V2.99.91): the CC hands a site to another company or brings one in to
// reinforce it from the picker; the leaving PC keeps recording until he taps "הוחלפתי - מסרתי"
// (or the CC marks him), then is read-only (strip banner, picker badge, no join) until the CC
// ends its access; the new company's PC is told once. The fake
// mirrors 096's access rules; the SQL is tested by scripts/rls_test_096_unit_handover.sql.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_platoon_security_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INC1 = '11111111-aaaa-4aaa-8aaa-111111111111'; // company A, platoon A1
const INC2 = '22222222-bbbb-4bbb-8bbb-222222222222'; // company B
const CC = '33333333-3333-4333-8333-333333333333';
const PC1 = '22222222-2222-4222-8222-222222222222';
const PC2 = '44444444-4444-4444-8444-444444444444';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '55555555-5555-4555-8555-555555555555';
const RPC1 = '66666666-6666-4666-8666-666666666666';
const RCC1 = '77777777-7777-4777-8777-777777777777';
const CA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const AMB = 'abababab-0000-4000-8000-0000000000ab';
const A1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
const B1 = 'b1b1b1b1-0000-4000-8000-0000000000b1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const USERS = {
  'cc@test': { id: CC, role: 'cc', display_name: 'מ"פ בדיקה' },
  'pc1@test': { id: PC1, role: 'pc', display_name: 'חוג"ד א' },
  'pc2@test': { id: PC2, role: 'pc', display_name: 'חוג"ד ב' },
  'm1@test': { id: M1, role: 'medic', display_name: 'חובש א' },
  'm2@test': { id: M2, role: 'medic', display_name: 'חובש ב' },
  'rpc1@test': { id: RPC1, role: 'rpc', display_name: 'מ"מ א1' },
  'rcc1@test': { id: RCC1, role: 'rcc', display_name: 'מ"פ חילוץ א' },
};
const UNIT_MANAGERS = ['cc', 'chamal', 'admin', 'physician'];
const SEES_ALL = ['cc', 'chamal', 'admin', 'physician', 'paramedic'];
const userById = (id) => Object.values(USERS).find((u) => u.id === id);

function newServer() {
  const now = new Date().toISOString();
  return {
    incidents: [
      { id: INC1, visual_id: 'INC-A1', status: 'active', location_name: 'מוקד פלוגה א', address: null, incident_type: null, metadata: {}, company_id: CA, platoon_id: A1 },
      { id: INC2, visual_id: 'INC-B', status: 'active', location_name: 'מוקד פלוגה ב', address: null, incident_type: null, metadata: {}, company_id: CB, platoon_id: null },
    ],
    members: [
      { incident_id: INC1, profile_id: PC1, role_at_incident: 'pc', assigned_by: PC1, created_at: now },
      { incident_id: INC2, profile_id: PC2, role_at_incident: 'pc', assigned_by: PC2, created_at: now },
    ],
    companies: [
      { id: CA, name: 'פלוגה א', kind: 'rescue', is_active: true },
      { id: CB, name: 'פלוגה ב', kind: 'rescue', is_active: true },
      { id: AMB, name: 'אמבולנס', kind: 'ambulance', is_active: true },
    ],
    platoons: [{ id: A1, company_id: CA, name: 'A1', is_active: true }, { id: B1, company_id: CB, name: 'B1', is_active: true }],
    // M2 starts without a unit
    units: { [PC1]: { company_id: CA }, [M1]: { company_id: CA }, [RCC1]: { company_id: CA }, [RPC1]: { platoon_id: A1 }, [PC2]: { company_id: CB } },
    links: [], // database/096 incident_unit_links
    noticeAcks: [],
    unitCalls: [],
  };
}
let seq = 0;
function handle(server, req) {
  const u = userById(req.userId);
  if (!u) return { data: null, error: { message: 'not signed in' } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const match = (row) => Object.entries(req.eq || {}).every(([c, v]) => row[c] === v)
    && Object.entries(req.in || {}).every(([c, v]) => v.includes(row[c]))
    && (req.notNull || []).every((c) => row[c] != null);
  const unit = (id) => server.units[id] || {};
  const companyOf = (id) => unit(id).company_id || server.platoons.find((p) => p.id === unit(id).platoon_id)?.company_id || null;
  // database/096: a read-only membership no longer counts as a member; it still reads.
  const member = (incId, uid = u.id) => server.members.some((m) => m.incident_id === incId && m.profile_id === uid && !m.read_only_since);
  const myCompany = companyOf(u.id);
  const myPlatoon = unit(u.id).platoon_id || null;
  const full = (inc) => SEES_ALL.includes(u.role) || member(inc.id)
    || (['pc', 'rcc'].includes(u.role) && !!myCompany && inc.company_id === myCompany)
    || (u.role === 'rpc' && !!myPlatoon && inc.platoon_id === myPlatoon);
  const readOnly = (inc) => server.members.some((m) => m.incident_id === inc.id && m.profile_id === u.id && m.read_only_since && !m.access_ended_at)
    || (['pc', 'rcc'].includes(u.role) && !!myCompany && server.links.some((l) => l.incident_id === inc.id && l.company_id === myCompany && l.read_only_since && !l.ended_at && (l.link_kind === 'former' || u.role === 'pc')))
    || (u.role === 'rpc' && !!myPlatoon && server.links.some((l) => l.incident_id === inc.id && l.link_kind === 'former' && l.platoon_id === myPlatoon && !l.ended_at));
  const canSee = (inc) => full(inc) || readOnly(inc);
  const UNIT_CHANGERS = ['cc', 'chamal', 'admin'];
  // 096 relief: the leaving company's medical staff wait for relief (full), its rcc / rpc are
  // read-only at once, its PCs are kept as members.
  const startRelief = (incId, company, at) => {
    Object.values(USERS).filter((x) => x.role === 'pc' && companyOf(x.id) === company && !server.members.some((m) => m.incident_id === incId && m.profile_id === x.id))
      .forEach((x) => server.members.push({ incident_id: incId, profile_id: x.id, role_at_incident: 'pc', assigned_by: u.id, created_at: at, relief_pending_since: at }));
    const mine = server.members.filter((m) => m.incident_id === incId && companyOf(m.profile_id) === company && !m.read_only_since);
    mine.filter((m) => ['pc', 'medic', 'paramedic'].includes(m.role_at_incident) && !m.relief_pending_since).forEach((m) => { m.relief_pending_since = at; });
    mine.filter((m) => ['rcc', 'rpc'].includes(m.role_at_incident)).forEach((m) => { m.read_only_since = at; });
    return server.members.filter((m) => m.incident_id === incId && companyOf(m.profile_id) === company && m.relief_pending_since && !m.read_only_since).length;
  };
  const restore = (incId, company) => server.members
    .filter((m) => m.incident_id === incId && companyOf(m.profile_id) === company && !m.access_ended_at && (m.read_only_since || m.relief_pending_since))
    .map((m) => { m.read_only_since = null; m.relief_pending_since = null; return m; }).length;
  const denied = (msg) => ({ data: null, error: { code: '42501', message: msg } });
  if (req.kind === 'rpc') {
    const p = req.params || {};
    if (req.name === 'list_open_incidents') {
      return { data: clone(server.incidents.filter((i) => i.status === 'active' && canSee(i)).map((i) => ({ ...i, patient_count: 0, is_member: member(i.id), read_only: !full(i) }))), error: null };
    }
    if (req.name === 'join_incident') {
      if (['pc', 'rpc', 'rcc', 'medic', 'paramedic'].includes(u.role) && !full(server.incidents.find((i) => i.id === p.p_incident_id) || {})) return denied('assignment required');
      if (!member(p.p_incident_id)) server.members.push({ incident_id: p.p_incident_id, profile_id: u.id, role_at_incident: u.role, assigned_by: u.id, created_at: new Date().toISOString() });
      return { data: { id: p.p_incident_id }, error: null };
    }
    if (req.name === 'create_company') {
      if (!UNIT_MANAGERS.includes(u.role)) return denied('only company-level command');
      const row = { id: 'cccccccc-0000-4000-8000-' + String(++seq).padStart(12, '0'), name: p.p_name, kind: p.p_kind || 'rescue', is_active: true };
      server.companies.push(row);
      return { data: { id: row.id, name: row.name }, error: null };
    }
    if (req.name === 'create_platoon') {
      if (!UNIT_MANAGERS.includes(u.role)) return denied('only company-level command');
      if (server.companies.find((c) => c.id === p.p_company_id)?.kind !== 'rescue') return { data: null, error: { code: '22023', message: 'platoons belong to a rescue company' } };
      const row = { id: 'dddddddd-0000-4000-8000-' + String(++seq).padStart(12, '0'), company_id: p.p_company_id, name: p.p_name, is_active: true };
      server.platoons.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (req.name === 'set_profile_unit') {
      if (!UNIT_MANAGERS.includes(u.role)) return denied('only company-level command');
      const target = userById(p.p_profile_id);
      const platoonRole = ['rpc', 'medic', 'paramedic'].includes(target.role);
      if ((p.p_company_id && p.p_platoon_id) || (target.role === 'rpc' && p.p_company_id) || (!platoonRole && p.p_platoon_id)) return { data: null, error: { code: '22023', message: 'wrong unit for role' } };
      server.units[p.p_profile_id] = { company_id: p.p_company_id, platoon_id: p.p_platoon_id };
      return { data: { profile_id: p.p_profile_id }, error: null };
    }
    if (req.name === 'set_incident_unit') {
      const inc = server.incidents.find((i) => i.id === p.p_incident_id);
      const rccOk = u.role === 'rcc' && !!myCompany && p.p_company_id === myCompany && (!inc.company_id || inc.company_id === myCompany);
      if (!UNIT_MANAGERS.includes(u.role) && !rccOk) return denied('only company-level command');
      inc.company_id = p.p_company_id; inc.platoon_id = p.p_platoon_id;
      return { data: { incident_id: p.p_incident_id }, error: null };
    }
    if (['handover_incident_unit', 'reinforce_incident_unit', 'release_incident_unit', 'end_incident_unit_access'].includes(req.name)) {
      server.unitCalls.push({ name: req.name, by: u.id, params: clone(p) });
      if (!UNIT_CHANGERS.includes(u.role)) return denied('only the medical company commander (cc), chamal or admin');
      const inc = server.incidents.find((i) => i.id === p.p_incident_id);
      const at = new Date().toISOString();
      const openLink = (company) => server.links.find((l) => l.incident_id === inc.id && l.company_id === company && !l.ended_at);
      if (req.name !== 'end_incident_unit_access' && req.name !== 'release_incident_unit' && !String(p.p_reason || '').trim()) return { data: null, error: { code: '22023', message: 'a reason is required' } };
      if (req.name === 'handover_incident_unit') {
        if (inc.company_id === p.p_company_id) return { data: null, error: { code: '22023', message: 'the site already belongs to that company' } };
        let pending = 0;
        if (inc.company_id) { server.links.push({ id: 'link-' + (++seq), incident_id: inc.id, link_kind: 'former', company_id: inc.company_id, platoon_id: inc.platoon_id, to_company_id: p.p_company_id, started_at: at, read_only_since: at, reason: p.p_reason }); pending = startRelief(inc.id, inc.company_id, at); }
        const back = openLink(p.p_company_id); if (back) back.ended_at = at;
        restore(inc.id, p.p_company_id);
        inc.company_id = p.p_company_id; inc.platoon_id = null;
        return { data: { incident_id: inc.id, changed_at: at, relief_pending: pending }, error: null };
      }
      if (req.name === 'reinforce_incident_unit') {
        if (inc.company_id === p.p_company_id) return { data: null, error: { code: '22023', message: 'own company' } };
        const prev = openLink(p.p_company_id); if (prev) prev.ended_at = at;
        restore(inc.id, p.p_company_id);
        const link = { id: 'link-' + (++seq), incident_id: inc.id, link_kind: 'reinforcing', company_id: p.p_company_id, started_at: at, read_only_since: null, reason: p.p_reason };
        server.links.push(link);
        const pcs = Object.values(USERS).filter((x) => x.role === 'pc' && companyOf(x.id) === p.p_company_id);
        pcs.forEach((x) => { const ex = server.members.find((m) => m.incident_id === inc.id && m.profile_id === x.id); if (ex) { ex.read_only_since = null; ex.access_ended_at = null; ex.relief_pending_since = null; } else server.members.push({ incident_id: inc.id, profile_id: x.id, role_at_incident: 'pc', assigned_by: u.id, created_at: at }); });
        return { data: { incident_id: inc.id, link_id: link.id, pcs_added: pcs.length }, error: null };
      }
      if (req.name === 'release_incident_unit') {
        const l = server.links.find((x) => x.incident_id === inc.id && x.company_id === p.p_company_id && x.link_kind === 'reinforcing' && !x.ended_at && !x.read_only_since);
        if (!l) return { data: null, error: { code: '22023', message: 'not reinforcing' } };
        l.read_only_since = at;
        return { data: { changed_at: at, relief_pending: startRelief(inc.id, p.p_company_id, at) }, error: null };
      }
      const l = server.links.find((x) => x.incident_id === inc.id && x.company_id === p.p_company_id && !x.ended_at && x.read_only_since);
      if (!l) return { data: null, error: { code: '22023', message: 'no read-only access' } };
      l.ended_at = at;
      let n = 0;
      server.members.filter((m) => m.incident_id === inc.id && (m.read_only_since || m.relief_pending_since) && !m.access_ended_at && companyOf(m.profile_id) === p.p_company_id)
        .forEach((m) => { m.read_only_since = m.read_only_since || at; m.access_ended_at = at; n++; });
      return { data: { members_ended: n }, error: null };
    }
    if (req.name === 'confirm_incident_relief') {
      server.unitCalls.push({ name: req.name, by: u.id, params: clone(p) });
      const target = p.p_profile_id || u.id;
      if (!(target === u.id || UNIT_CHANGERS.includes(u.role) || (u.role === 'pc' && companyOf(target) === myCompany))) return denied('only the person, his PC or the CC');
      const m = server.members.find((x) => x.incident_id === p.p_incident_id && x.profile_id === target && x.relief_pending_since && !x.read_only_since);
      if (!m) return { data: null, error: { code: '22023', message: 'no relief is waiting' } };
      m.read_only_since = new Date().toISOString(); m.relieved_by = u.id;
      return { data: { profile_id: target, read_only_since: m.read_only_since }, error: null };
    }
    if (req.name === 'get_incident_unit_links') {
      const inc = server.incidents.find((i) => i.id === p.p_incident_id);
      if (!inc || !canSee(inc)) return denied('access denied');
      const mine = server.members.find((m) => m.incident_id === inc.id && m.profile_id === u.id && m.read_only_since);
      const myLink = server.links.find((l) => l.incident_id === inc.id && !l.ended_at && l.read_only_since && l.company_id === myCompany);
      return { data: { incident_id: inc.id, company_id: inc.company_id, company_name: server.companies.find((c) => c.id === inc.company_id)?.name || null,
        my_access: !full(inc) ? 'read_only' : (server.members.some((m) => m.incident_id === inc.id && m.profile_id === u.id && m.relief_pending_since && !m.read_only_since) ? 'relief_pending' : 'full'),
        relief_pending: clone(server.members.filter((m) => m.incident_id === inc.id && m.relief_pending_since && !m.read_only_since
          && (UNIT_CHANGERS.includes(u.role) || (u.role === 'pc' && companyOf(m.profile_id) === myCompany) || m.profile_id === u.id))
          .map((m) => ({ profile_id: m.profile_id, display_name: USERS[Object.keys(USERS).find((k) => USERS[k].id === m.profile_id)]?.display_name || m.profile_id, role: m.role_at_incident, since: m.relief_pending_since }))),
        my_read_only_since: full(inc) ? null : (mine?.read_only_since || myLink?.read_only_since || null),
        links: clone(server.links.filter((l) => l.incident_id === inc.id).map((l) => ({ id: l.id, kind: l.link_kind, company_id: l.company_id, company_name: server.companies.find((c) => c.id === l.company_id)?.name, started_at: l.started_at, read_only_since: l.read_only_since, ended_at: l.ended_at || null }))) }, error: null };
    }
    if (req.name === 'list_incident_unit_notices') {
      if (!['pc', 'rcc', 'rpc'].includes(u.role) || !myCompany) return { data: [], error: null };
      const rows = server.links.filter((l) => !server.noticeAcks.some((a) => a.link_id === l.id && a.profile_id === u.id)).filter((l) => {
        const inc = server.incidents.find((i) => i.id === l.incident_id);
        return (l.link_kind === 'former' && l.to_company_id === myCompany && inc.company_id === myCompany)
          || (l.link_kind === 'reinforcing' && l.company_id === myCompany && u.role === 'pc' && !l.ended_at && !l.read_only_since);
      }).map((l) => { const inc = server.incidents.find((i) => i.id === l.incident_id); return { link_id: l.id, incident_id: inc.id, visual_id: inc.visual_id, location_name: inc.location_name,
        kind: l.link_kind === 'former' ? 'handover' : 'reinforce', from_company_name: server.companies.find((c) => c.id === l.company_id)?.name,
        site_company_name: server.companies.find((c) => c.id === inc.company_id)?.name, at: l.started_at, reason: l.reason }; });
      return { data: rows, error: null };
    }
    if (req.name === 'list_pending_reliefs') {
      if (!['cc', 'chamal', 'admin', 'pc'].includes(u.role)) return { data: [], error: null };
      const rows = server.members.filter((m) => m.relief_pending_since && !m.read_only_since).filter((m) => {
        const inc = server.incidents.find((i) => i.id === m.incident_id);
        return inc && inc.status === 'active' && (UNIT_CHANGERS.includes(u.role) || inc.company_id === myCompany);
      }).map((m) => { const inc = server.incidents.find((i) => i.id === m.incident_id); return { incident_id: inc.id, visual_id: inc.visual_id, location_name: inc.location_name, profile_id: m.profile_id,
        display_name: USERS[Object.keys(USERS).find((k) => USERS[k].id === m.profile_id)]?.display_name || m.profile_id, role_at_incident: m.role_at_incident, pending_since: m.relief_pending_since, server_now: new Date().toISOString() }; });
      return { data: clone(rows), error: null };
    }
    if (req.name === 'acknowledge_incident_unit_notice') { server.noticeAcks.push({ link_id: p.p_link_id, profile_id: u.id }); return { data: { acknowledged: true }, error: null }; }
    if (req.name === 'get_incident_command_state') { const inc = server.incidents.find((i) => i.id === p.p_incident_id); return { data: inc ? { incident_id: inc.id, status: inc.status, state_json: {} } : null, error: null }; }
    return { data: null, error: null };
  }
  if (req.table === 'profiles') {
    let rows = Object.values(USERS).map((x) => ({ id: x.id, role: x.role, display_name: x.display_name, is_active: true, company_id: unit(x.id).company_id || null, platoon_id: unit(x.id).platoon_id || null }));
    if (!UNIT_MANAGERS.includes(u.role)) rows = rows.filter((r) => r.id === u.id || (u.role === 'pc' && !!myCompany && companyOf(r.id) === myCompany));
    rows = rows.filter(match);
    return { data: req.single ? (rows[0] || null) : rows, error: null };
  }
  if (req.table === 'companies') return { data: clone(server.companies), error: null };
  if (req.table === 'platoons') return { data: clone(server.platoons), error: null };
  if (req.table === 'incidents') {
    const visible = server.incidents.filter((i) => canSee(i) && match(i));
    if (req.op === 'update') { visible.forEach((i) => Object.assign(i, clone(req.payload))); return { data: visible.map((i) => ({ id: i.id })), error: null }; }
    const data = req.single ? (visible[0] || null) : visible;
    return { data: clone(data), error: req.single && !data ? { message: 'no rows' } : null };
  }
  if (req.table === 'incident_memberships') {
    if (req.op === 'upsert') {
      const r = clone(req.payload);
      const target = userById(r.profile_id);
      const pcOk = u.role === 'pc' && r.profile_id !== u.id && ['medic', 'paramedic'].includes(target?.role)
        && !!myCompany && (member(r.incident_id) || server.incidents.find((i) => i.id === r.incident_id)?.company_id === myCompany)
        && companyOf(r.profile_id) === myCompany;
      if (!UNIT_MANAGERS.includes(u.role) && !pcOk) return denied('new row violates row-level security policy');
      const ex = server.members.find((m) => m.incident_id === r.incident_id && m.profile_id === r.profile_id);
      if (ex) Object.assign(ex, r); else server.members.push({ created_at: new Date().toISOString(), ...r });
      return { data: null, error: null };
    }
    let vis = server.members.filter((r) => r.profile_id === u.id || UNIT_MANAGERS.includes(u.role) || (u.role === 'pc' && canSee(server.incidents.find((i) => i.id === r.incident_id) || {}))).filter(match);
    if (req.order) vis.sort((a, c) => (a[req.order.c] > c[req.order.c] ? 1 : -1) * (req.order.asc ? 1 : -1));
    if (req.limit) vis = vis.slice(0, req.limit);
    return { data: clone(req.single ? (vis[0] || null) : vis), error: null };
  }
  return { data: req.single ? null : [], error: null };
}

// The in-page client: builds each query and sends it to the Node-side server above.
const FAKE_SUPABASE = `
(function(){
  const USERS=${JSON.stringify(USERS)};
  const session=()=>{ try{ return JSON.parse(sessionStorage.getItem('__fake_session')); }catch(e){ return null; } };
  const userId=()=>session()?.user?.id||null;
  function builder(table){
    const q={kind:'from',table,op:'select',eq:{},in:{},notNull:[],single:false,order:null,limit:null,payload:null,ignoreDup:false};
    const b={};
    b.select=()=>b; b.eq=(c,v)=>{ q.eq[c]=v; return b; }; b.in=(c,v)=>{ q.in[c]=v; return b; };
    b.not=(c,op,v)=>{ if(op==='is'&&v===null) q.notNull.push(c); return b; };
    b.order=(c,o)=>{ q.order={c,asc:o?.ascending!==false}; return b; }; b.limit=n=>{ q.limit=n; return b; };
    b.single=()=>{ q.single=true; return b; }; b.maybeSingle=b.single;
    b.update=p=>{ q.op='update'; q.payload=p; return b; };
    b.upsert=(p,o)=>{ q.op='upsert'; q.payload=p; q.ignoreDup=!!o?.ignoreDuplicates; return b; };
    ['gte','gt','lt','lte','neq','is','range','insert','delete'].forEach(m=>{ b[m]=b[m]||(()=>b); });
    b.then=(resolve,reject)=>window.__fakeServer({...q,userId:userId()}).then(resolve,reject);
    return b;
  }
  window.supabase={createClient:()=>({
    auth:{
      signInWithPassword:async({email})=>{ const u=USERS[email]; if(!u) return {data:null,error:{message:'bad'}}; sessionStorage.setItem('__fake_session',JSON.stringify({access_token:'tok-'+u.id,user:{id:u.id}})); return {data:{user:{id:u.id}},error:null}; },
      getSession:async()=>({data:{session:session()},error:null}),
      getUser:async()=>{ const id=userId(); const e=Object.entries(USERS).find(([,u])=>u.id===id); return {data:{user:e?{id,email:e[0]}:null}}; },
      signOut:async()=>{ sessionStorage.removeItem('__fake_session'); return {error:null}; },
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      verifyOtp:async()=>({error:{message:'n/a'}}), updateUser:async()=>({error:null}), resetPasswordForEmail:async()=>({error:null})
    },
    from:t=>builder(t),
    rpc:(name,params)=>window.__fakeServer({kind:'rpc',name,params,userId:userId()})
  })};
})();`;

async function openPhone(context, file) {
  const page = await context.newPage();
  const errors = [];
  const toasts = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
  await page.route('**/functions/v1/sync-log**', (r) => r.request().method() === 'POST'
    ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: [], duplicates: [], rejected: [] }) })
    : r.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [], next_cursor: 0, has_more: false }) }));
  await page.exposeFunction('__toastSpy', (m) => toasts.push(m));
  await page.addInitScript(() => { window.addEventListener('DOMContentLoaded', () => { const orig = window.toast; window.toast = (m, ...a) => { window.__toastSpy(String(m)); return orig && orig(m, ...a); }; }); });
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  if (await page.locator('#pin-gate-setup-panel').isVisible()) {
    await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  } else {
    await page.fill('#pin-gate-unlock-input', PIN); await page.click('#pin-gate-unlock-btn');
  }
  return { page, errors, toasts, dialogs };
}
async function login(page, email) {
  await page.waitForSelector('#screen-login.active', { timeout: 5000 });
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'synthetic');
  await page.click('#login-submit-btn');
  await page.waitForFunction(() => !!currentUser, null, { timeout: 5000 });
  await page.waitForTimeout(400);
}
let SERVER = null;


async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  SERVER = newServer();
  await context.exposeBinding('__fakeServer', (_source, req) => handle(SERVER, req));
  const bodyRowAfter = async (page, label) => {
    const lines = (await page.locator('#role-dashboard-body').innerText()).split('\n');
    const i = lines.findIndex((l) => l.trim() === label);
    return i < 0 ? '' : lines.slice(i, i + 3).join(' ');
  };

  // PC2 (company B) cannot reach company A's site: not listed, and a direct join is refused.
  const pc2 = await openPhone(context, file);
  await login(pc2.page, 'pc2@test');
  const listed = await pc2.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(!listed.includes(INC1), `${rel}: PC2 must not see company A's site in the picker (got ${JSON.stringify(listed)})`);
  await pc2.page.evaluate((id) => { _openIncidents.push({ id, visual_id: 'X', status: 'active', is_member: false }); return enterIncidentFromPicker(id); }, INC1);
  await pc2.page.waitForTimeout(300);
  assert(await pc2.page.evaluate((id) => activeIncident?.id !== id, INC1), `${rel}: PC2 must not enter company A's site`);
  assert(pc2.toasts.some((t) => t.includes('נדרש שיבוץ')), `${rel}: a refused join must say an assignment is needed (got ${JSON.stringify(pc2.toasts)})`);
  assert(!SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === PC2), `${rel}: no membership may be created by a refused join`);

  // RPC1 (platoon A1, no membership): reaches its platoon's site only.
  const rpc1 = await openPhone(context, file);
  await login(rpc1.page, 'rpc1@test');
  const rpcListed = await rpc1.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(rpcListed.includes(INC1) && !rpcListed.includes(INC2), `${rel}: RPC must see exactly its platoon's site (got ${JSON.stringify(rpcListed)})`);
  await rpc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await rpc1.page.waitForTimeout(300);
  await rpc1.page.evaluate(() => pullIncidentAssignmentState());
  assert(await rpc1.page.evaluate(() => realUnitName(_myPlatoonId)) === 'פלוגה א · A1', `${rel}: RPC must know its platoon and company`);

  // RCC1 (company A): its company's site only; its tiles are its own company's platoons.
  const rcc1 = await openPhone(context, file);
  await login(rcc1.page, 'rcc1@test');
  const rccListed = await rcc1.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(rccListed.includes(INC1) && !rccListed.includes(INC2), `${rel}: RCC must see exactly its company's site (got ${JSON.stringify(rccListed)})`);
  await rcc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await rcc1.page.waitForTimeout(300);
  await rcc1.page.evaluate(() => pullIncidentAssignmentState());
  const rccTiles = await rcc1.page.evaluate(() => commandPlatoons().map((p) => p.name));
  assert(rccTiles.includes('A1') && !rccTiles.includes('B1') && !rccTiles.includes('פלוגה א'), `${rel}: RCC tiles must be its own company's platoons (got ${JSON.stringify(rccTiles)})`);
  // Since V2.99.80 the company line sits with the responsibilities, behind the strip's button.
  await rcc1.page.evaluate(() => { startRoleDashboard('rcc'); if(!rccResponsibilitiesOpen) toggleRccResponsibilities(); });
  assert((await bodyRowAfter(rcc1.page, 'הפלוגה שלי')).includes('פלוגה א'), `${rel}: the RCC dashboard must name its company`);
  await rcc1.page.evaluate(() => toggleRccResponsibilities());

  // CC: roster panel shows the site's unit, creates a company and a platoon, places people; the
  // CC dashboard lists the real rescue companies (not the ambulance, not the demo platoons).
  const cc = await openPhone(context, file);
  await login(cc.page, 'cc@test');
  await cc.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await cc.page.waitForTimeout(300);
  await cc.page.evaluate(() => startRoleDashboard('cc'));
  // V2.99.62: the roster is on the CC panel's כוחות tab.
  await cc.page.click('[data-cmd-tab="forces"]');
  await cc.page.waitForSelector('[data-roster-member]', { timeout: 5000 });
  assert(await cc.page.inputValue(`[data-incident-unit="${INC1}"]`) === `p:${A1}`, `${rel}: the roster panel must show the site's platoon`);
  await cc.page.fill('#new-company-name', 'פלוגה ג');
  await cc.page.evaluate(() => createCompanyFromPanel());
  await cc.page.waitForTimeout(300);
  assert(SERVER.companies.some((c) => c.name === 'פלוגה ג' && c.kind === 'rescue'), `${rel}: CC must be able to create a rescue company`);
  await cc.page.selectOption('#new-platoon-company', CA);
  await cc.page.fill('#new-platoon-name', 'A2');
  await cc.page.evaluate(() => createPlatoonFromPanel());
  await cc.page.waitForTimeout(300);
  const A2 = SERVER.platoons.find((p) => p.name === 'A2' && p.company_id === CA)?.id;
  assert(!!A2, `${rel}: CC must be able to create a platoon in company A`);
  await cc.page.waitForSelector(`[data-roster-member="${M2}"]`, { timeout: 5000 });
  // database/065: a medic is attached to a מ"מ's platoon (here A2); its company follows.
  await cc.page.selectOption(`[data-roster-member="${M2}"]`, `p:${A2}`);
  await cc.page.waitForTimeout(300);
  assert(SERVER.units[M2].platoon_id === A2 && !SERVER.units[M2].company_id, `${rel}: CC must attach a medic to a platoon`);
  await cc.page.selectOption(`[data-roster-member="${RPC1}"]`, A2);
  await cc.page.waitForTimeout(300);
  assert(SERVER.units[RPC1].platoon_id === A2 && !SERVER.units[RPC1].company_id, `${rel}: CC must place a מ"מ in a platoon`);
  const ccTiles = await cc.page.evaluate(() => commandPlatoons().map((p) => p.name));
  assert(ccTiles.includes('פלוגה א') && ccTiles.includes('פלוגה ב') && ccTiles.includes('פלוגה ג') && !ccTiles.includes('אמבולנס') && !ccTiles.includes('מחלקה רפואית א'),
    `${rel}: CC tiles must be the real rescue companies (got ${JSON.stringify(ccTiles)})`);
  await cc.page.click('[data-cmd-tab="overview"]');
  assert((await cc.page.locator('#role-dashboard-body').innerText()).includes('פלוגות פעילות'), `${rel}: CC dashboard must count companies`);
  const ccOptions = await cc.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.role); });
  assert(ccOptions.includes('pc'), `${rel}: CC must be offered PC accounts to assign`);
  await cc.page.evaluate((id) => assignRealMedic(id, '', ''), PC2);
  assert(SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === PC2 && m.assigned_by === CC), `${rel}: CC must be able to assign a PC to a site`);

  // RPC1 now leads A2: the A1 site is gone from its picker.
  const rpcAfter = await rpc1.page.evaluate(async () => { await refreshOpenIncidents(); return (_openIncidents || []).map((i) => i.id); });
  assert(!rpcAfter.includes(INC1), `${rel}: after moving to A2 the מ"מ must no longer see A1's site (got ${JSON.stringify(rpcAfter)})`);

  // PC1: offered exactly its company's medics; cannot change the roster; names its company.
  const pc1 = await openPhone(context, file);
  await login(pc1.page, 'pc1@test');
  await pc1.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await pc1.page.waitForTimeout(300);
  const pc1Options = await pc1.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.id); });
  assert(pc1Options.length === 2 && pc1Options.includes(M1) && pc1Options.includes(M2), `${rel}: PC1 must be offered exactly the medics under its guidance (got ${JSON.stringify(pc1Options)})`);
  // M2 is attached to platoon A2; INC1 is A1's site. The PC may still send it there.
  await pc1.page.evaluate((id) => assignRealMedic(id, '', ''), M2);
  assert(SERVER.members.some((m) => m.incident_id === INC1 && m.profile_id === M2 && m.assigned_by === PC1), `${rel}: PC1 must assign an A2 medic to an A1 site`);
  // PC2 (company B) is offered none of company A's medics.
  const pc2Options = await pc2.page.evaluate(async () => { await loadRealMedicProfiles(); return _realMedicProfiles.map((p) => p.id); });
  assert(!pc2Options.includes(M1) && !pc2Options.includes(M2), `${rel}: PC2 must not be offered company A's medics (got ${JSON.stringify(pc2Options)})`);
  assert(!(await pc1.page.evaluate(() => canManagePlatoonRoster())), `${rel}: a PC must not be offered the roster panel`);
  await pc1.page.evaluate(() => startRoleDashboard('pc'));
  assert(await pc1.page.locator('#platoon-roster-panel').count() === 0, `${rel}: no roster panel on the PC dashboard`);
  await pc1.page.click('[data-cmd-tab="forces"]'); // V2.99.62: "הפלוגה שלי" is on the כוחות tab
  assert((await bodyRowAfter(pc1.page, 'הפלוגה שלי')).includes('פלוגה א'), `${rel}: the PC dashboard must name its company`);

  // ---- WP-27 (database/096): hand INC2 (company B) to company A; reinforce INC1 with company B.
  await pc2.page.evaluate(async (id) => { await refreshOpenIncidents(); await enterIncidentFromPicker(id); }, INC2);
  await pc2.page.waitForTimeout(300);
  assert(await pc2.page.evaluate((id) => activeIncident?.id === id, INC2), `${rel}: PC2 must be in its own site before the handover`);
  // Only cc / chamal / admin are offered the action.
  await pc1.page.evaluate(() => openIncidentPicker());
  await pc1.page.waitForTimeout(300);
  assert(await pc1.page.locator('button', { hasText: 'העברה / תגבור פלוגה' }).count() === 0, `${rel}: a PC must not be offered handover / reinforce`);
  // A company change in the CC roster no longer moves a site silently: it opens the panel.
  await cc.page.evaluate(() => startRoleDashboard('cc'));
  await cc.page.click('[data-cmd-tab="forces"]');
  await cc.page.waitForSelector(`[data-incident-unit="${INC1}"]`, { timeout: 5000 });
  await cc.page.selectOption(`[data-incident-unit="${INC1}"]`, `c:${CB}`);
  await cc.page.waitForSelector(`[data-unit-panel="${INC1}"]`, { timeout: 5000 });
  assert(SERVER.incidents.find((i) => i.id === INC1).company_id === CA, `${rel}: the roster must not move a site to another company directly`);
  // Handover from the picker: reason required, then the site is company A's with no platoon.
  await cc.page.evaluate((id) => { _unitPanelFor = null; return toggleIncidentUnitPanel(id); }, INC2);
  await cc.page.waitForSelector(`[data-unit-panel="${INC2}"] select`, { timeout: 5000 });
  await cc.page.selectOption(`#unit-company-${INC2}`, CA);
  await cc.page.evaluate((id) => submitIncidentUnitChange(id), INC2);
  assert(await cc.page.locator(`#unit-error-${INC2}`).innerText() === 'חובה לציין סיבה', `${rel}: a handover without a reason must be refused on the phone`);
  assert(!SERVER.unitCalls.some((c) => c.name === 'handover_incident_unit'), `${rel}: nothing is sent without a reason`);
  await cc.page.fill(`#unit-reason-${INC2}`, 'פלוגה ב יוצאת למנוחה');
  await cc.page.evaluate((id) => submitIncidentUnitChange(id), INC2);
  await cc.page.waitForTimeout(300);
  const inc2 = SERVER.incidents.find((i) => i.id === INC2);
  assert(inc2.company_id === CA && inc2.platoon_id === null, `${rel}: the handover must give the site to company A with no platoon (got ${JSON.stringify(inc2)})`);
  const pc2m = SERVER.members.find((m) => m.incident_id === INC2 && m.profile_id === PC2);
  assert(pc2m.relief_pending_since && !pc2m.read_only_since, `${rel}: PC2 must keep recording until relieved (got ${JSON.stringify(pc2m)})`);
  assert(cc.toasts.some((t) => t.includes('האתר הועבר לפלוגה א') && t.includes('ממתינים להחלפה')), `${rel}: the CC must be told the site moved and who waits (got ${JSON.stringify(cc.toasts)})`);
  // Not yet 30 minutes: no alert. At 31 minutes the site's PC (now PC1) and the CC are alerted.
  await pc1.page.evaluate(() => pollIncidentOpenAlerts());
  assert(!(await pc1.page.locator('#incident-relief-overdue-banner').isVisible()), `${rel}: no relief alert before 30 minutes`);
  pc2m.relief_pending_since = new Date(Date.now() - 31 * 60000).toISOString();
  await pc1.page.evaluate(() => pollIncidentOpenAlerts());
  await pc1.page.waitForSelector(`#incident-relief-overdue-banner [data-relief-overdue="${INC2}"]`, { timeout: 5000 });
  const overduePc = await pc1.page.locator('#incident-relief-overdue-banner').innerText();
  assert(overduePc.includes('לא אישרו החלפה') && overduePc.includes('31 דק'), `${rel}: the site's PC must see who has not confirmed relief for 30+ minutes (got "${overduePc}")`);
  await cc.page.evaluate(() => pollIncidentOpenAlerts());
  await cc.page.waitForSelector(`#incident-relief-overdue-banner [data-relief-overdue="${INC2}"] button`, { timeout: 5000 });
  await rpc1.page.evaluate(() => pollIncidentOpenAlerts());
  assert(!(await rpc1.page.locator('#incident-relief-overdue-banner').isVisible()), `${rel}: the rescue chain gets no relief alert`);
  // The leaving PC: told to keep recording, then "הוחלפתי - מסרתי" makes him read-only.
  await pc2.page.evaluate(() => refreshIncidentContext());
  await pc2.page.waitForSelector('#incident-readonly-banner [data-relief-self]', { timeout: 5000 });
  assert(pc2.toasts.some((t) => t.includes('המשך לתעד')), `${rel}: PC2 must be told to keep recording until relieved (got ${JSON.stringify(pc2.toasts)})`);
  await pc2.page.evaluate(() => openIncidentPicker());
  await pc2.page.waitForTimeout(300);
  assert(await pc2.page.locator('[data-readonly-badge]').count() === 0, `${rel}: no read-only badge before the relief`);
  await pc2.page.evaluate((id) => enterIncidentFromPicker(id), INC2);
  await pc2.page.waitForTimeout(300);
  // An unsent record on PC2's phone: the relief tries to send it first and warns while it is not sent.
  await pc2.page.evaluate((id) => {
    const ob = getOutbox();
    ob.push({ type: 'NOTE_ADDED', incident_id: id, synced: false, local_event_id: 'relief-unsent-1', device_id: getDeviceId(), local_timestamp: new Date().toISOString(), payload_json: {} });
    persistOutbox(ob);
    window.__origSyncPush = syncPush; syncPush = async () => {}; // offline: nothing goes out
  }, INC2);
  pc2.dialogs.length = 0;
  await pc2.page.click('#incident-readonly-banner [data-relief-self]');
  await pc2.page.waitForTimeout(300);
  assert(pc2.dialogs.some((d) => d.includes('רישומים שעוד לא נשלחו')), `${rel}: relieving himself with unsent records must warn first (got ${JSON.stringify(pc2.dialogs)})`);
  assert(pc2.toasts.some((t) => t.includes('שולח 1 רישומים לפני ההחלפה')), `${rel}: the phone must try to send its records before the relief`);
  await pc2.page.evaluate(() => { syncPush = window.__origSyncPush; const ob = getOutbox(); const i = ob.findIndex((e) => e.local_event_id === 'relief-unsent-1'); if (i >= 0) ob.splice(i, 1); persistOutbox(); });
  assert(pc2m.read_only_since && pc2m.relieved_by === PC2, `${rel}: "הוחלפתי - מסרתי" must relieve PC2 himself`);
  await pc1.page.evaluate(() => pollIncidentOpenAlerts());
  assert(!(await pc1.page.locator('#incident-relief-overdue-banner').isVisible()), `${rel}: the relief alert must go once he is relieved`);
  // A record refused after the relief says why and offers no retry that cannot work.
  await pc2.page.evaluate(() => refreshIncidentContext());
  await pc2.page.waitForTimeout(200);
  const relRej = await pc2.page.evaluate(() => {
    const ob = getOutbox();
    ob.push({ type: 'VITALS_RECORDED', patient_id: 'p-relief-x', syncRejected: true, syncRejectReason: 'FORBIDDEN_ACTOR_ROLE', syncRejectMessage: 'new row violates row-level security policy' });
    const html = patientSyncRejectionBanner({ id: 'p-relief-x' });
    ob.pop();
    return { readOnly: isActiveIncidentReadOnly(), explains: html.includes('data-relief-rejection'), retry: html.includes('retryPatientSync') };
  });
  assert(relRej.readOnly && relRej.explains && !relRej.retry, `${rel}: after relief a refused record must say why, with no retry (got ${JSON.stringify(relRej)})`);
  // Signed in, the demo title above the dashboard is hidden (the sync pill stays).
  await pc2.page.evaluate(() => startRoleDashboard('pc'));
  assert(await pc2.page.locator('#role-context-line').evaluate((el) => el.closest('.demo-strip').classList.contains('signed-in-compact') && getComputedStyle(el.parentElement).display === 'none'),
    `${rel}: the demo title must be hidden on the signed-in dashboard`);
  const roBanner = await pc2.page.locator('#incident-readonly-banner').innerText();
  assert(roBanner.includes('צפייה בלבד') && roBanner.includes('פלוגה א'), `${rel}: PC2 must see a read-only banner naming the new company (got "${roBanner}")`);
  assert(pc2.toasts.some((t) => t.includes('צפייה בלבד')), `${rel}: PC2 must be told once that it is read-only`);
  await pc2.page.evaluate(() => openIncidentPicker());
  await pc2.page.waitForTimeout(300);
  assert(await pc2.page.locator('[data-readonly-badge]').count() === 1, `${rel}: the picker must mark the read-only site`);
  // The new PC: told once, then the notice is gone.
  await pc1.page.evaluate(() => pollIncidentOpenAlerts());
  await pc1.page.waitForSelector('#incident-unit-notice-banner [data-unit-notice]', { timeout: 5000 });
  assert((await pc1.page.locator('#incident-unit-notice-banner').innerText()).includes('אתר הועבר לפלוגה שלך'), `${rel}: PC1 must be told the site was handed to its company`);
  await pc1.page.click('#incident-unit-notice-banner [data-unit-notice] button:has-text("ראיתי")');
  await pc1.page.waitForTimeout(200);
  assert(!(await pc1.page.locator('#incident-unit-notice-banner').isVisible()), `${rel}: the notice must go after "ראיתי"`);
  await pc1.page.evaluate(() => pollIncidentOpenAlerts());
  assert(!(await pc1.page.locator('#incident-unit-notice-banner').isVisible()), `${rel}: an acknowledged notice must not come back`);
  // Reinforce INC1 with company B, then release it.
  await cc.page.evaluate((id) => { _unitPanelFor = null; return toggleIncidentUnitPanel(id); }, INC1);
  await cc.page.waitForSelector(`[data-unit-panel="${INC1}"]`, { timeout: 5000 });
  await cc.page.evaluate(() => setIncidentUnitPanelMode('reinforce'));
  await cc.page.selectOption(`#unit-company-${INC1}`, CB);
  await cc.page.fill(`#unit-reason-${INC1}`, 'עומס פצועים');
  await cc.page.evaluate((id) => submitIncidentUnitChange(id), INC1);
  await cc.page.waitForTimeout(300);
  assert(SERVER.incidents.find((i) => i.id === INC1).company_id === CA, `${rel}: reinforcement must leave the site with company A`);
  assert(SERVER.links.some((l) => l.incident_id === INC1 && l.link_kind === 'reinforcing' && l.company_id === CB), `${rel}: reinforcement must be recorded`);
  await pc2.page.evaluate(() => pollIncidentOpenAlerts());
  await pc2.page.waitForSelector('#incident-unit-notice-banner [data-unit-notice]', { timeout: 5000 });
  assert((await pc2.page.locator('#incident-unit-notice-banner').innerText()).includes('הפלוגה שלך נשלחה לתגבר'), `${rel}: PC2 must be told its company reinforces a site`);
  await cc.page.waitForSelector(`[data-unit-panel="${INC1}"] button:has-text("שחרור תגבור")`, { timeout: 5000 });
  await cc.page.click(`[data-unit-panel="${INC1}"] button:has-text("שחרור תגבור")`);
  await cc.page.waitForTimeout(300);
  const pc2r = SERVER.members.find((m) => m.incident_id === INC1 && m.profile_id === PC2);
  assert(pc2r.relief_pending_since && !pc2r.read_only_since, `${rel}: after release company B's PC must keep recording until relieved`);
  // The CC marks him relieved (his phone is gone) from the panel's waiting list.
  await cc.page.waitForSelector(`[data-unit-panel="${INC1}"] [data-relief-row="${PC2}"] button`, { timeout: 5000 });
  await cc.page.click(`[data-unit-panel="${INC1}"] [data-relief-row="${PC2}"] button`);
  await cc.page.waitForTimeout(300);
  assert(pc2r.read_only_since && pc2r.relieved_by === CC, `${rel}: the CC's "סמן כהוחלף" must relieve PC2`);
  await pc2.page.evaluate(() => pollIncidentOpenAlerts());
  assert(!(await pc2.page.locator('#incident-unit-notice-banner').isVisible()), `${rel}: a released reinforcement's notice must go`);
  // End company B's read-only access to INC2: the old PC is told its access ended.
  await cc.page.evaluate((id) => { _unitPanelFor = null; return toggleIncidentUnitPanel(id); }, INC2);
  await cc.page.waitForSelector(`[data-unit-panel="${INC2}"] button:has-text("סיום גישה")`, { timeout: 5000 });
  await cc.page.click(`[data-unit-panel="${INC2}"] button:has-text("סיום גישה")`);
  await cc.page.waitForTimeout(300);
  assert(SERVER.members.find((m) => m.incident_id === INC2 && m.profile_id === PC2).access_ended_at, `${rel}: ending access must end PC2's membership`);
  await pc2.page.evaluate(async (id) => { if (activeIncident?.id !== id) { activeIncident = { ...activeIncident, id }; } await refreshIncidentContext(); }, INC2);
  await pc2.page.waitForTimeout(200);
  assert((await pc2.page.locator('#incident-readonly-banner').innerText()).includes('הגישה שלך לאתר הסתיימה'), `${rel}: PC2 must be told its access ended`);
  // Signed in, the CC quick action opens the panel instead of moving a demo patient.
  await cc.page.evaluate((id) => enterIncidentFromPicker(id), INC1);
  await cc.page.waitForTimeout(300);
  await cc.page.evaluate(() => { _unitPanelFor = null; return demoReassignBetweenPlatoons(); });
  await cc.page.waitForSelector(`[data-unit-panel="${INC1}"]`, { timeout: 5000 });

  const errors = [...pc2.errors, ...rpc1.errors, ...rcc1.errors, ...cc.errors, ...pc1.errors];
  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: unit security scope browser test passed`);
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const file of files) await checkFile(browser, file);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
