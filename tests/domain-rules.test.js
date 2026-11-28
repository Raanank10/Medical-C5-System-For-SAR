const assert = require("node:assert/strict");
const rules = require("../src/domain/rules");

const baseTime = Date.UTC(2026, 4, 19, 10, 0, 0);

function patient(overrides = {}) {
  return {
    accessibility: "full",
    patientStatus: "monitoring",
    triage: "red",
    lastVitalsAt: baseTime,
    ...overrides,
  };
}

assert.equal(rules.needsVitals(patient()), true);
assert.equal(rules.needsVitals(patient({ trapStatus: "trapped" })), true);
assert.equal(rules.needsVitals(patient({ patientStatus: "evacuated" })), false);
assert.equal(rules.needsVitals(patient({ patientStatus: "evacuating" })), false);
assert.equal(rules.needsVitals(patient({ patientStatus: "deceased" })), false);
assert.equal(rules.needsVitals(patient({ patientStatus: "handed_over" })), false);
assert.equal(rules.needsVitals(patient({ triage: "black" })), false);
assert.equal(rules.isPediatricPatient({ patientAge: 7 }), true);
assert.equal(rules.isPediatricPatient({ patientAgeGroup: "pediatric" }), true);
assert.equal(rules.isPediatricPatient({ patientAge: 8 }), false);
assert.equal(rules.isPediatricPatient({ patientAge: null, patientAgeGroup: "adult" }), false);
assert.equal(rules.isHighRiskDose("morphine", 5, { patientAge: 6 }), true);
assert.equal(rules.isHighRiskDose("morphine", 4, { patientAge: 6 }), true);
assert.equal(rules.isHighRiskDose("morphine", 2, { patientAge: 6 }), false);
assert.equal(rules.isHighRiskDose("fentanyl", 10, { patientAgeGroup: "pediatric" }), true);
assert.equal(rules.isHighRiskDose("fentanyl", 4, { patientAgeGroup: "pediatric" }), false);
assert.equal(rules.isHighRiskDose("morphine", 10, { patientAge: 12 }), false);

// Vitals reassessment interval varies by triage color - red tightest (10m), yellow (20m),
// green loosest (30m). Unset/unrecognized triage (e.g. freshly created, not yet MSTART-triaged)
// defaults to the red interval - most conservative until an actual color is known.
assert.deepEqual(rules.vitalsTimer(patient(), baseTime + 2 * 60 * 1000), {
  cls: "ok",
  minutes: 2,
  remainingMinutes: 8,
});
assert.deepEqual(rules.vitalsTimer(patient(), baseTime + 9 * 60 * 1000), {
  cls: "warn",
  minutes: 9,
  remainingMinutes: 1,
});
assert.deepEqual(rules.vitalsTimer(patient(), baseTime + 11 * 60 * 1000), {
  cls: "overdue",
  minutes: 11,
  remainingMinutes: 0,
});
assert.deepEqual(rules.vitalsTimer(patient({ triage: "yellow" }), baseTime + 15 * 60 * 1000), {
  cls: "ok",
  minutes: 15,
  remainingMinutes: 5,
});
assert.deepEqual(rules.vitalsTimer(patient({ triage: "yellow" }), baseTime + 21 * 60 * 1000), {
  cls: "overdue",
  minutes: 21,
  remainingMinutes: 0,
});
assert.deepEqual(rules.vitalsTimer(patient({ triage: "green" }), baseTime + 25 * 60 * 1000), {
  cls: "ok",
  minutes: 25,
  remainingMinutes: 5,
});
assert.deepEqual(rules.vitalsTimer(patient({ triage: "green" }), baseTime + 31 * 60 * 1000), {
  cls: "overdue",
  minutes: 31,
  remainingMinutes: 0,
});

assert.equal(rules.vitalsIntervalMsFor("red"), 10 * 60 * 1000);
assert.equal(rules.vitalsIntervalMsFor("yellow"), 20 * 60 * 1000);
assert.equal(rules.vitalsIntervalMsFor("green"), 30 * 60 * 1000);
assert.equal(rules.vitalsIntervalMsFor("pending"), 10 * 60 * 1000);
assert.equal(rules.vitalsIntervalMsFor(undefined), 10 * 60 * 1000);

assert.equal(rules.isVitalsOverdue(patient({ triage: "yellow" }), baseTime + 15 * 60 * 1000), false);
assert.equal(rules.isVitalsOverdue(patient({ triage: "yellow" }), baseTime + 21 * 60 * 1000), true);
assert.equal(rules.isVitalsOverdue(patient({ triage: "green" }), baseTime + 25 * 60 * 1000), false);
assert.equal(rules.isVitalsOverdue(patient({ triage: "green" }), baseTime + 31 * 60 * 1000), true);
assert.equal(rules.isVitalsOverdue(patient({ triage: "black" }), baseTime + 60 * 60 * 1000), false);

// Tourniquet review: notice (heads-up) at 45m, yellow/warn at 60m, red/critical at 120m.
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 30 * 60 * 1000),
  { cls: "", stage: "", minutes: 30, limb: "right leg" },
);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 45 * 60 * 1000),
  { cls: "notice", stage: "notice", minutes: 45, limb: "right leg" },
);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 61 * 60 * 1000),
  { cls: "warn", stage: "warn", minutes: 61, limb: "right leg" },
);
// 100 minutes (owner, 2026-10-26): a decision point before the medic's 120-minute release window
// closes. Same orange colour (cls), its own alert stage.
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 99 * 60 * 1000),
  { cls: "warn", stage: "warn", minutes: 99, limb: "right leg" },
);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 100 * 60 * 1000),
  { cls: "warn", stage: "decision", minutes: 100, limb: "right leg" },
);
assert.equal(rules.TOURNIQUET_DECISION_MS, 100 * 60 * 1000);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 121 * 60 * 1000),
  { cls: "critical", stage: "critical", minutes: 121, limb: "right leg" },
);

// Device silence: one canonical 10-minute threshold shared across the medic load board,
// the command-view device panel, and the Dead Man's Switch watchdog row (previously three
// different values: 4m/5m/>5m).
assert.equal(rules.isDeviceSilent(baseTime, baseTime + 9 * 60 * 1000), false);
assert.equal(rules.isDeviceSilent(baseTime, baseTime + 11 * 60 * 1000), true);
assert.equal(rules.isDeviceSilent(0, baseTime), true);
assert.equal(rules.isDeviceSilent(null, baseTime), true);

// Inventory burn-rate / stock-out risk (docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md §10.3):
// burn rate = items consumed per 10m, stock-out risk = current stock / recent burn rate.
assert.equal(rules.supplyCriticalThreshold(5), 2);
assert.equal(rules.supplyCriticalThreshold(8), 3);
assert.equal(rules.supplyRiskTier(1, 5, 2), "critical");
assert.equal(rules.supplyRiskTier(3, 5, 2), "warning");
assert.equal(rules.supplyRiskTier(6, 5, 2), "ok");

const supplyEvents = [
  { type: "SUPPLY_CONSUMED", local_timestamp: new Date(baseTime - 2 * 60 * 1000).toISOString(), payload_json: { item_type: "tourniquets", quantity_delta: -2 } },
  { type: "SUPPLY_CONSUMED", local_timestamp: new Date(baseTime - 9 * 60 * 1000).toISOString(), payload_json: { item_type: "tourniquets", quantity_delta: -1 } },
  { type: "SUPPLY_CONSUMED", local_timestamp: new Date(baseTime - 11 * 60 * 1000).toISOString(), payload_json: { item_type: "tourniquets", quantity_delta: -5 } },
  { type: "SUPPLY_CONSUMED", local_timestamp: new Date(baseTime - 1 * 60 * 1000).toISOString(), payload_json: { item_type: "tourniquets", quantity_delta: 3 } },
  { type: "SUPPLY_CONSUMED", local_timestamp: new Date(baseTime - 1 * 60 * 1000).toISOString(), payload_json: { item_type: "pressureDressings", quantity_delta: -4 } },
];
// -11m falls outside the 10-minute window and a positive delta is a restock, not burn - both excluded.
assert.equal(rules.supplyBurnRatePer10Min(supplyEvents, "tourniquets", baseTime), 3);
assert.equal(rules.supplyBurnRatePer10Min(supplyEvents, "pressureDressings", baseTime), 4);
assert.equal(rules.supplyBurnRatePer10Min(supplyEvents, "blankets", baseTime), 0);

assert.equal(rules.minutesToStockout(6, 3), 20);
assert.equal(rules.minutesToStockout(6, 0), null);
assert.equal(rules.minutesToStockout(0, 3), 0);

assert.equal(rules.supplyBurnAlertLevel({ remaining: 1, warningThreshold: 5, criticalThreshold: 2, minutesToStockout: null }), "CRITICAL");
assert.equal(rules.supplyBurnAlertLevel({ remaining: 4, warningThreshold: 5, criticalThreshold: 2, minutesToStockout: null }), "HIGH");
assert.equal(rules.supplyBurnAlertLevel({ remaining: 10, warningThreshold: 5, criticalThreshold: 2, minutesToStockout: 10 }), "CRITICAL");
assert.equal(rules.supplyBurnAlertLevel({ remaining: 10, warningThreshold: 5, criticalThreshold: 2, minutesToStockout: 25 }), "HIGH");
assert.equal(rules.supplyBurnAlertLevel({ remaining: 10, warningThreshold: 5, criticalThreshold: 2, minutesToStockout: 40 }), null);

assert.equal(rules.computeMstartTriage({ rr: 0 }), "black");
assert.equal(rules.computeMstartTriage({ rr: 34, bp_estimate: "radial", avpu: "A", spo2: 98 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "absent", avpu: "A", spo2: 98 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial", avpu: "V", spo2: 98 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial", avpu: "A", spo2: 91 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial", avpu: "A", spo2: 98 }), "green");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "weak", avpu: "A", spo2: 98 }), "yellow");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial_strong", avpu: "A", spo2: 98 }), "green");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial_weak", avpu: "A", spo2: 98 }), "yellow");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "carotid_weak", avpu: "A", spo2: 98 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: null, avpu: null, spo2: null }), "yellow");

assert.deepEqual(
  rules.suggestMstartTriage({ vitals: { rr: 16, bp_estimate: "radial", avpu: "A", spo2: 98 } }),
  { triage: "green", reason: "מדדים תקינים · AVPU A", reasons: [] },
);
assert.equal(
  rules.suggestMstartTriage({ vitals: { rr: 8, bp_estimate: "carotid", avpu: "P", spo2: 90 } }).triage,
  "red",
);

// suggestedSweepColor: the live MSTART sweep classifier (walking/breathing/perfusion/AVPU/trapped
// qualitative fields, not full vitals). This is the function actually called during the fast
// first-pass sweep in index.html — distinct from suggestMstartTriage, which runs later during
// full-vitals re-triage. Previously had zero test coverage despite making the sweep's black/red call.
assert.equal(rules.suggestedSweepColor({ walking: "yes" }), "green");
assert.equal(
  rules.suggestedSweepColor({ breathing: "no", airwayOpened: true, breathingAfterAirway: "no" }),
  "black",
);
assert.equal(rules.suggestedSweepColor({ breathing: "no", airwayOpened: false }), "red");
assert.equal(
  rules.suggestedSweepColor({ breathing: "no", airwayOpened: true, breathingAfterAirway: "yes" }),
  "red",
);
assert.equal(rules.suggestedSweepColor({ breathing: "yes", perfusion: "absent" }), "black");
assert.equal(rules.suggestedSweepColor({ breathing: "yes", perfusion: "carotid_only" }), "red");
assert.equal(rules.suggestedSweepColor({ breathing: "yes", perfusion: "radial_weak" }), "red");
assert.equal(rules.suggestedSweepColor({ breathing: "yes", perfusion: "radial_strong", avpu: "V" }), "red");
assert.equal(
  rules.suggestedSweepColor({ breathing: "yes", perfusion: "radial_strong", avpu: "A", trapped: "trapped" }),
  "yellow",
);
assert.equal(
  rules.suggestedSweepColor({ breathing: "yes", perfusion: "radial_strong", avpu: "A", trapped: "immobile" }),
  "yellow",
);
assert.equal(
  rules.suggestedSweepColor({ breathing: "yes", perfusion: "radial_strong", avpu: "A" }),
  "yellow",
);
assert.equal(
  rules.suggestedSweepColor({ walking: "no", overrideReason: "medic override", color: "red" }),
  "red",
);
assert.equal(
  rules.suggestedSweepColor({ walking: "yes", lifeThreateningHemorrhage: true }),
  "red",
);

assert.deepEqual(
  rules.detectDeterioration({ pulse: 100, spo2: 98, avpu: "A" }, { pulse: 70, spo2: 92, avpu: "P" }),
  ["⬇ SpO₂ 98→92%", "⬇ AVPU A→P", "⚡ דופק 100→70"],
);
// Breathing rate climbing: rise of 8/min or more, ending at 21 or above.
assert.deepEqual(rules.detectDeterioration({ rr: 16 }, { rr: 24 }), ["⬆ נשימות 16→24"]);
assert.deepEqual(rules.detectDeterioration({ rr: 14 }, { rr: 20 }), []);   // rise 6, still normal
assert.deepEqual(rules.detectDeterioration({ rr: 18 }, { rr: 24 }), []);   // rise 6: counting noise
assert.deepEqual(rules.detectDeterioration({ rr: 10 }, { rr: 18 }), []);   // back towards normal
assert.deepEqual(rules.detectDeterioration({ rr: 13 }, { rr: 21 }), ["⬆ נשימות 13→21"]);
assert.deepEqual(rules.detectDeterioration({ rr: 28 }, { rr: 18 }), []);   // falling is not this flag
assert.deepEqual(rules.detectDeterioration({ rr: 16 }, { rr: null }), []); // not counted this time
assert.deepEqual(rules.detectDeterioration({ rr: 0 }, { rr: 12 }), []);    // apnoea -> breathing: MSTART's call

// FINAL_PATIENT_STATUSES / canChangePatientStatus: once a patient reaches deceased,
// handed_over, evacuated, closed, or self_evacuated, mutation sites (handover, manual
// triage override, sweep color override) must refuse to overwrite them. "evacuating" is
// deliberately not final - a patient waiting at the site's evacuation point (נאפ״ל, נקודת איסוף פלוגתית) under
// the platoon commander's supervision must still be able to reach handed_over.
assert.equal(rules.isFinalPatientStatus("deceased"), true);
assert.equal(rules.isFinalPatientStatus("handed_over"), true);
assert.equal(rules.isFinalPatientStatus("evacuated"), true);
assert.equal(rules.isFinalPatientStatus("closed"), true);
assert.equal(rules.isFinalPatientStatus("self_evacuated"), true);
assert.equal(rules.isFinalPatientStatus("evacuating"), false);
assert.equal(rules.isFinalPatientStatus("stabilizing"), false);
assert.equal(rules.isFinalPatientStatus(undefined), false);

assert.equal(rules.canChangePatientStatus(patient({ patientStatus: "observing" })), true);
assert.equal(rules.canChangePatientStatus(patient({ patientStatus: "evacuating" })), true);
assert.equal(rules.canChangePatientStatus(patient({ patientStatus: "deceased" })), false);
assert.equal(rules.canChangePatientStatus(patient({ patientStatus: "handed_over" })), false);
assert.equal(rules.canChangePatientStatus(patient({ patientStatus: "evacuated" })), false);
assert.equal(rules.canChangePatientStatus(null), true);

// MDA classification is recorded beside field triage, never instead of it. The mismatch flag is
// informational only and never fires when either side is unknown.
assert.deepEqual([...rules.MDA_CLASSIFICATIONS], ["minor", "anxiety", "moderate", "serious", "critical", "deceased"]);
assert.equal(rules.isValidMdaClassification("serious"), true);
assert.equal(rules.isValidMdaClassification("red"), false);
assert.equal(rules.isValidMdaClassification(undefined), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("red", "critical"), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("red", "serious"), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("red", "minor"), true);
assert.equal(rules.mdaClassificationDiffersFromTriage("yellow", "moderate"), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("yellow", "serious"), true);
assert.equal(rules.mdaClassificationDiffersFromTriage("green", "anxiety"), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("green", "moderate"), true);
assert.equal(rules.mdaClassificationDiffersFromTriage("black", "deceased"), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("black", "critical"), true);
assert.equal(rules.mdaClassificationDiffersFromTriage("pending", "minor"), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("red", null), false);
assert.equal(rules.mdaClassificationDiffersFromTriage("red", "bogus"), false);

// Pre-evacuation report (database/050): the first medical staff on site enters it, after that only
// pc / cc (and admin) may change it. Same rule the server trigger applies.
for (const role of ["medic", "paramedic", "physician", "pc", "cc", "admin"]) {
  assert.equal(rules.canWritePreEvacuationReport(role, false), true, `${role} may enter the first report`);
}
for (const role of ["rpc", "rcc", "chamal", "logistics", "logistics_officer", undefined]) {
  assert.equal(rules.canWritePreEvacuationReport(role, false), false, `${role} may not enter it`);
}
for (const role of ["pc", "cc", "admin"]) {
  assert.equal(rules.canWritePreEvacuationReport(role, true), true, `${role} may change it`);
}
for (const role of ["medic", "paramedic", "physician", "rpc", "chamal"]) {
  assert.equal(rules.canWritePreEvacuationReport(role, true), false, `${role} may not change it once entered`);
}
assert.deepEqual(rules.PRE_EVAC_CONDITION_TO_TRIAGE, { light: "green", moderate: "yellow", severe: "red" });
assert.deepEqual(
  rules.normalizePreEvacuationGroups([
    { count: 3, condition: "light", evacuatedBy: "mda", destination: "  Hospital A  " },
    { count: "2", condition: "severe", evacuatedBy: "civilian" },
    { count: 1, condition: "moderate", evacuatedBy: "unknown-org", destination: "B" },
    { count: 0, condition: "light", evacuatedBy: "mda" },
    { count: 1.5, condition: "light", evacuatedBy: "mda" },
    { count: 4, condition: "critical", evacuatedBy: "mda" },
    { count: 10000, condition: "light", evacuatedBy: "mda" },
    null,
  ]),
  [
    { count: 3, condition: "light", evacuatedBy: "mda", destination: "Hospital A" },
    { count: 2, condition: "severe", evacuatedBy: "civilian", destination: "" },
    { count: 1, condition: "moderate", evacuatedBy: "other", destination: "B" },
  ],
);
assert.deepEqual(rules.normalizePreEvacuationGroups(undefined), []);
assert.equal(rules.normalizePreEvacuationGroups(Array.from({ length: 60 }, () => ({ count: 1, condition: "light" }))).length, 50);
assert.deepEqual(
  rules.preEvacuationTotals([
    { count: 3, condition: "light", evacuatedBy: "mda" },
    { count: 2, condition: "light", evacuatedBy: "self" },
    { count: 1, condition: "moderate", evacuatedBy: "fire" },
    { count: 4, condition: "severe", evacuatedBy: "united_hatzalah" },
    { count: 9, condition: "bogus" },
  ]),
  { light: 5, moderate: 1, severe: 4, total: 10 },
);

// D1: the phone alerts each tourniquet time level once, on its own clock.
assert.equal(rules.tourniquetAlertToRaise("", null), null);
assert.equal(rules.tourniquetAlertToRaise("notice", null), "notice");
assert.equal(rules.tourniquetAlertToRaise("notice", "notice"), null);
assert.equal(rules.tourniquetAlertToRaise("warn", "notice"), "warn");
assert.equal(rules.tourniquetAlertToRaise("critical", "warn"), "critical");
assert.equal(rules.tourniquetAlertToRaise("critical", "critical"), null);
// Opened after a long time closed: only the current level alerts, not every level missed.
assert.equal(rules.tourniquetAlertToRaise("critical", null), "critical");
// Never alerts downwards (e.g. a clock correction).
assert.equal(rules.tourniquetAlertToRaise("warn", "critical"), null);
// The 100-minute decision level sits between warn and critical.
assert.equal(rules.tourniquetAlertToRaise("decision", "warn"), "decision");
assert.equal(rules.tourniquetAlertToRaise("decision", "decision"), null);
assert.equal(rules.tourniquetAlertToRaise("critical", "decision"), "critical");
assert.equal(rules.tourniquetAlertToRaise("warn", "decision"), null);

// Past 120 minutes, one level per full hour (owner, 2026-10-26): 3h, 4h, 5h, 6h, ... Red colour kept.
const tqAt = (min) => rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + min * 60 * 1000);
assert.equal(tqAt(179).stage, "critical");
assert.deepEqual(tqAt(180), { cls: "critical", stage: "hours_3", minutes: 180, limb: "right leg" });
assert.equal(tqAt(239).stage, "hours_3");
assert.equal(tqAt(240).stage, "hours_4");
assert.equal(tqAt(360).stage, "hours_6");
assert.equal(tqAt(421).stage, "hours_7");
assert.equal(rules.TOURNIQUET_PHYSICIAN_RELEASE_MAX_MS, 6 * 60 * 60 * 1000);
assert.equal(rules.tourniquetAlertRank("critical"), 4);
assert.equal(rules.tourniquetAlertRank("hours_3"), 5);
assert.equal(rules.tourniquetAlertRank("hours_6"), 8);
assert.equal(rules.tourniquetAlertRank("hours_2"), 0);
assert.equal(rules.tourniquetAlertRank("bogus"), 0);
assert.equal(rules.tourniquetAlertRank("toString"), 0);
assert.equal(rules.tourniquetAlertToRaise("hours_3", "critical"), "hours_3");
assert.equal(rules.tourniquetAlertToRaise("hours_3", "hours_3"), null);
assert.equal(rules.tourniquetAlertToRaise("hours_4", "hours_3"), "hours_4");
// Opened after hours closed: only the current hour alerts, once.
assert.equal(rules.tourniquetAlertToRaise("hours_5", "warn"), "hours_5");
assert.equal(rules.tourniquetAlertToRaise("critical", "hours_4"), null);

// Converting a tourniquet to direct pressure (owner, 2026-10-26 / 27 / 11-08): medic and PC up to
// 120 min, paramedic up to 4 h, physician up to 6 h, other roles never.
{
  const M = 60 * 1000;
  const ok = (role, min) => rules.tourniquetConversionAllowed(role, min * M);
  assert.deepEqual(ok("medic", 120), { allowed: true, limitMs: 120 * M, reason: null });
  assert.deepEqual(ok("medic", 121), { allowed: false, limitMs: 120 * M, reason: "time" });
  assert.equal(ok("pc", 119).allowed, true);
  assert.equal(ok("pc", 121).reason, "time");
  assert.equal(ok("paramedic", 121).allowed, true);
  assert.equal(ok("paramedic", 240).allowed, true);
  assert.deepEqual(ok("paramedic", 241), { allowed: false, limitMs: 240 * M, reason: "time" });
  assert.deepEqual(ok("physician", 300), { allowed: true, limitMs: 360 * M, reason: null });
  assert.deepEqual(ok("physician", 360), { allowed: true, limitMs: 360 * M, reason: null });
  assert.deepEqual(ok("physician", 361), { allowed: false, limitMs: 360 * M, reason: "time" });
  // admin (owner 2026-11-08): every option open, with the physician's limits.
  assert.deepEqual(ok("admin", 300), { allowed: true, limitMs: 360 * M, reason: null });
  assert.deepEqual(ok("admin", 361), { allowed: false, limitMs: 360 * M, reason: "time" });
  assert.equal(rules.tourniquetConversionAllowed("admin", NaN).reason, "time_unknown");
  for (const role of ["cc", "chamal", "rpc", "rcc", "logistics_officer", "", undefined, "toString"]) {
    assert.deepEqual(rules.tourniquetConversionAllowed(role, 10 * M), { allowed: false, limitMs: null, reason: "role" }, String(role));
  }
  assert.equal(rules.tourniquetConversionAllowed("medic", NaN).reason, "time_unknown");
  assert.equal(rules.tourniquetConversionAllowed("paramedic", null).reason, "time_unknown");
  assert.deepEqual(rules.tourniquetConversionAllowed("physician", NaN), { allowed: false, limitMs: 360 * 60 * 1000, reason: "time_unknown" });
}

// Tourniquet time from the 4 digits written on the body (owner, 2026-11-08). Local time, no date.
{
  const at = (h, m) => new Date(2026, 10, 8, h, m, 0, 0).getTime();
  const now = at(14, 20);
  const parse = (code, n = now) => rules.parseTourniquetTimeCode(code, n);
  assert.deepEqual(parse("1355"), { ok: true, appliedAtMs: at(13, 55), minutesAgo: 25, needsConfirm: false });
  assert.deepEqual(parse("1420"), { ok: true, appliedAtMs: now, minutesAgo: 0, needsConfirm: false });
  // a watch up to 5 minutes fast counts as just now
  assert.deepEqual(parse("1422"), { ok: true, appliedAtMs: now, minutesAgo: 0, needsConfirm: false });
  assert.deepEqual(parse("1425"), { ok: true, appliedAtMs: now, minutesAgo: 0, needsConfirm: false });
  // 5-60 min later: not read; the medic chooses (type again / yesterday, offered here / no time)
  assert.deepEqual(parse("1426"), { ok: false, reason: "future", aheadMinutes: 6, yesterdayAtMs: new Date(2026, 10, 7, 14, 26).getTime(), yesterdayMinutesAgo: 1434 });
  assert.deepEqual(parse("1445"), { ok: false, reason: "future", aheadMinutes: 25, yesterdayAtMs: new Date(2026, 10, 7, 14, 45).getTime(), yesterdayMinutesAgo: 1415 });
  assert.deepEqual(parse("1520"), { ok: false, reason: "future", aheadMinutes: 60, yesterdayAtMs: new Date(2026, 10, 7, 15, 20).getTime(), yesterdayMinutesAgo: 1380 });
  // more than an hour later: yesterday, and asked about because it is more than 12 h ago
  assert.deepEqual(parse("1600"), { ok: true, appliedAtMs: new Date(2026, 10, 7, 16, 0).getTime(), minutesAgo: 1340, needsConfirm: true });
  // 13 h ago across midnight: asked about, not refused
  assert.deepEqual(parse("2351", at(12, 51)), { ok: true, appliedAtMs: new Date(2026, 10, 7, 23, 51).getTime(), minutesAgo: 780, needsConfirm: true });
  // more than 12 hours ago: accepted after confirmation
  assert.deepEqual(parse("0130"), { ok: true, appliedAtMs: at(1, 30), minutesAgo: 770, needsConfirm: true });
  assert.equal(parse("0220").needsConfirm, false); // exactly 12 h
  // across midnight: 2350 entered at 00:20 is yesterday, 30 minutes ago
  assert.deepEqual(parse("2350", at(0, 20)), { ok: true, appliedAtMs: new Date(2026, 10, 7, 23, 50).getTime(), minutesAgo: 30, needsConfirm: false });
  assert.deepEqual(parse("0030", at(0, 20)), { ok: false, reason: "future", aheadMinutes: 10, yesterdayAtMs: new Date(2026, 10, 7, 0, 30).getTime(), yesterdayMinutesAgo: 1430 });
  // yesterday afternoon seen early in the morning, within 12 h: fine
  assert.deepEqual(parse("1500", at(1, 0)), { ok: true, appliedAtMs: new Date(2026, 10, 7, 15, 0).getTime(), minutesAgo: 600, needsConfirm: false });
  for (const bad of ["", null, undefined, "930", "09:30", "2400", "1260", "abcd", "12345"]) {
    assert.deepEqual(parse(bad), { ok: false, reason: "format" }, String(bad));
  }
}

// "Remind me later" on tourniquet alerts (owner, 2026-10-26): delay length and count per level;
// the last allowed delay escalates to command; then no more delays.
assert.deepEqual(rules.tourniquetSnoozeOption("notice", 0), { minutes: 5, used: 1, max: 2, escalates: false });
assert.deepEqual(rules.tourniquetSnoozeOption("warn", 1), { minutes: 5, used: 2, max: 2, escalates: true });
assert.equal(rules.tourniquetSnoozeOption("warn", 2), null);
assert.deepEqual(rules.tourniquetSnoozeOption("decision", 0), { minutes: 2, used: 1, max: 1, escalates: true });
assert.equal(rules.tourniquetSnoozeOption("decision", 1), null);
assert.deepEqual(rules.tourniquetSnoozeOption("critical", undefined), { minutes: 1, used: 1, max: 1, escalates: true });
assert.equal(rules.tourniquetSnoozeOption("critical", 1), null);
assert.equal(rules.tourniquetSnoozeOption("", 0), null);

// PC review of a deteriorating casualty (WP-26).
assert.equal(rules.priorityRecommendationDirection("yellow", "red"), "worse");
assert.equal(rules.priorityRecommendationDirection("red", "black"), "worse");
assert.equal(rules.priorityRecommendationDirection("red", "yellow"), "better");
assert.equal(rules.priorityRecommendationDirection("yellow", "green"), "better");
assert.equal(rules.priorityRecommendationDirection("red", "red"), null);
assert.equal(rules.priorityRecommendationDirection("pending", "green"), "worse");
assert.equal(rules.priorityRecommendationDirection("red", null), null);
assert.equal(rules.priorityRecommendationDirection("black", "red"), "worse");
assert.equal(rules.priorityRecommendationDirection("green", "yellow"), "worse");
// Yellow trend (WP-26 follow-up, option B).
assert.equal(rules.nextDeteriorationStreak(0, true), 1);
assert.equal(rules.nextDeteriorationStreak(1, true), 2);
assert.equal(rules.nextDeteriorationStreak(2, false), 0);
assert.equal(rules.nextDeteriorationStreak(3, true, true), 1);
assert.equal(rules.nextDeteriorationStreak(3, false, true), 0);
assert.equal(rules.nextDeteriorationStreak(undefined, true), 1);
assert.equal(rules.shouldPromptYellowTrend("yellow", 1, false), false);
assert.equal(rules.shouldPromptYellowTrend("yellow", 2, false), true);
assert.equal(rules.shouldPromptYellowTrend("yellow", 2, true), false);
assert.equal(rules.shouldPromptYellowTrend("red", 3, false), false);
assert.equal(rules.shouldPromptYellowTrend("green", 3, false), false);
assert.deepEqual(rules.pcReviewSnoozeOption("immediate", 0), { minutes: 3, used: 1, max: 1, escalates: true });
assert.equal(rules.pcReviewSnoozeOption("immediate", 1), null);
assert.deepEqual(rules.pcReviewSnoozeOption("high", 0), { minutes: 5, used: 1, max: 2, escalates: false });
assert.deepEqual(rules.pcReviewSnoozeOption("high", 1), { minutes: 5, used: 2, max: 2, escalates: true });
assert.equal(rules.pcReviewSnoozeOption("high", 2), null);
assert.deepEqual(rules.pcReviewSnoozeOption("bogus", undefined), { minutes: 5, used: 1, max: 2, escalates: false });
{
  const t0 = Date.parse("2026-11-21T10:00:00Z");
  const at = new Date(t0).toISOString();
  assert.equal(rules.pcReviewState({ status: "pending", createdAt: at }, t0 + 4 * 60000), "waiting");
  assert.equal(rules.pcReviewState({ status: "pending", createdAt: at }, t0 + 5 * 60000), "unanswered");
  assert.equal(rules.pcReviewState({ status: "acknowledged", createdAt: at, snoozedUntil: new Date(t0 + 10 * 60000).toISOString() }, t0 + 9 * 60000), "snoozed");
  assert.equal(rules.pcReviewState({ status: "acknowledged", createdAt: at, snoozedUntil: new Date(t0 + 10 * 60000).toISOString() }, t0 + 10 * 60000), "unanswered");
  assert.equal(rules.pcReviewState({ status: "resolved", createdAt: at }, t0), "closed");
  assert.equal(rules.pcReviewState({ status: "cancelled", createdAt: at }, t0), "closed");
  assert.equal(rules.pcReviewState(null, t0), "closed");
}
assert.deepEqual(rules.tourniquetSnoozeOption("hours_3", 0), { minutes: 5, used: 1, max: 2, escalates: false });
assert.deepEqual(rules.tourniquetSnoozeOption("hours_6", 1), { minutes: 5, used: 2, max: 2, escalates: true });
assert.equal(rules.tourniquetSnoozeOption("hours_6", 2), null);
assert.equal(rules.tourniquetSnoozeOption("toString", 0), null);

// Command status strip: server contact freshness (V2.99.62).
{
  const now = 10_000_000;
  assert.deepEqual(rules.serverContactFreshness(now - 20_000, now), { level: "fresh", ageMs: 20_000 });
  assert.equal(rules.serverContactFreshness(now - 2 * 60_000, now).level, "fresh");
  assert.equal(rules.serverContactFreshness(now - 2 * 60_000 - 1, now).level, "stale");
  assert.equal(rules.serverContactFreshness(now - 5 * 60_000, now).level, "stale");
  assert.equal(rules.serverContactFreshness(now - 5 * 60_000 - 1, now).level, "offline");
  // No server response yet, or the device says it has no network: offline, never "connected".
  assert.deepEqual(rules.serverContactFreshness(null, now), { level: "offline", ageMs: null });
  assert.equal(rules.serverContactFreshness(0, now).level, "offline");
  assert.equal(rules.serverContactFreshness(now - 1000, now, false).level, "offline");
  // A clock that went backwards reads as just contacted, not as a negative age.
  assert.deepEqual(rules.serverContactFreshness(now + 5000, now), { level: "fresh", ageMs: 0 });
}

// Cancelling a resupply request (WP-24, owner 2026-11-18; the same rule as database/084).
{
  const can = rules.supplyRequestCancelAllowed;
  for (const role of ["cc", "chamal", "admin"]) {
    for (const level of ["medic_to_pc", "pc_to_logo"]) {
      assert.equal(can(role, "requested", level), true, `${role} requested ${level}`);
      assert.equal(can(role, "dispatched", level), true, `${role} dispatched ${level}`);
      assert.equal(can(role, "in_transit", level), true, `${role} in_transit ${level}`);
      // The PC truck already issued it; delivered and cancelled are final.
      for (const status of ["approved", "delivered", "cancelled"]) assert.equal(can(role, status, level), false, `${role} ${status}`);
    }
  }
  assert.equal(can("pc", "requested", "medic_to_pc"), true);
  assert.equal(can("pc", "requested", "pc_to_logo"), false); // once escalated, command above decides
  for (const status of ["approved", "dispatched", "in_transit", "delivered", "cancelled"]) assert.equal(can("pc", status, "medic_to_pc"), false, `pc ${status}`);
  for (const role of ["medic", "paramedic", "physician", "logistics_officer", "rpc", "rcc", "", undefined]) {
    assert.equal(can(role, "requested", "medic_to_pc"), false, String(role));
  }
  const valid = rules.supplyCancelReasonValid;
  assert.deepEqual(rules.SUPPLY_CANCEL_REASONS, ["not_needed", "duplicate", "supplied_otherwise", "other"]);
  assert.equal(valid("not_needed"), true);
  assert.equal(valid("duplicate", ""), true);
  assert.equal(valid("supplied_otherwise", null), true);
  assert.equal(valid("other", "הכוח עבר אתר"), true);
  assert.equal(valid("other", "   "), false);
  assert.equal(valid("other"), false);
  assert.equal(valid("bogus", "x"), false);
  assert.equal(valid(undefined), false);
}

// database/074: the rescue chain sees evacuation priority, never the colour.
assert.equal(rules.rescueEvacPriority("red", false), "urgent");
assert.equal(rules.rescueEvacPriority("green", true), "urgent"); // active tourniquet
assert.equal(rules.rescueEvacPriority("yellow", false), "not_urgent");
// Extraction by the rescue chain (owner, 2026-11-19): unsorted needs a medic's check; 60 minutes
// trapped or more needs a medic present (crush syndrome), whatever the priority.
assert.equal(rules.LONG_ENTRAPMENT_MINUTES, 60);
assert.equal(rules.rescueExtractionRequirement("urgent", 10), null);
assert.equal(rules.rescueExtractionRequirement("not_urgent", 59), null);
assert.equal(rules.rescueExtractionRequirement("pending", 10), "medic_check");
assert.equal(rules.rescueExtractionRequirement(undefined, null), "medic_check");
assert.equal(rules.rescueExtractionRequirement("not_urgent", 60), "medic_present");
assert.equal(rules.rescueExtractionRequirement("pending", 90), "medic_present");
assert.equal(rules.rescueExtractionRequirement("urgent", NaN), null);
assert.equal(rules.rescueEvacPriority("green", false), "not_urgent");
assert.equal(rules.rescueEvacPriority("black", false), "not_urgent");
// Not sorted yet is never "not urgent".
assert.equal(rules.rescueEvacPriority("pending", false), "pending");
assert.equal(rules.rescueEvacPriority(undefined, false), "pending");
assert.equal(rules.rescueEvacPriority("pending", true), "urgent");
assert.deepEqual(rules.RESCUE_PRIORITIES, ["urgent", "pending", "not_urgent"]);

// WP-27 (owner 2026-11-23): a relief still unconfirmed 30 minutes after it started alerts the site's PC and the CC.
{
  const now = Date.parse("2026-11-23T12:00:00Z");
  assert.equal(rules.reliefOverdueMinutes(now - 29 * 60000, now), null);
  assert.equal(rules.reliefOverdueMinutes(now - 30 * 60000 + 1, now), null); // 1 ms short of 30 minutes
  assert.equal(rules.reliefOverdueMinutes(now - 30 * 60000, now), 30);
  assert.equal(rules.reliefOverdueMinutes(now - 95 * 60000 - 30000, now), 95);
  assert.equal(rules.reliefOverdueMinutes(null, now), null);
  assert.equal(rules.reliefOverdueMinutes(NaN, now), null);
  assert.equal(rules.reliefOverdueMinutes(now + 60000, now), null); // a clock ahead is not overdue
  assert.equal(rules.RELIEF_OVERDUE_MS, 30 * 60000);
}

// WP-40 (owner 2026-11-19): waiting for a vehicle after leaving for the נאפ״ל, from when the patient was sent.
{
  const now = Date.parse("2026-11-19T12:00:00Z");
  const sent = (min, extra = {}) => ({ patientStatus: "evacuating", triage: "yellow", evacSentAt: now - min * 60000, ...extra });
  assert.equal(rules.evacPointWaitAlert(sent(29), now), null);
  assert.deepEqual(rules.evacPointWaitAlert(sent(30), now), { level: "warning", minutes: 30 });
  assert.deepEqual(rules.evacPointWaitAlert(sent(59), now), { level: "warning", minutes: 59 });
  assert.deepEqual(rules.evacPointWaitAlert(sent(60), now), { level: "critical", minutes: 60 });
  assert.deepEqual(rules.evacPointWaitAlert(sent(45, { triage: "green" }), now), { level: "warning", minutes: 45 }); // every colour
  assert.deepEqual(rules.evacPointWaitAlert(sent(45, { triage: "pending" }), now), { level: "warning", minutes: 45 });
  assert.equal(rules.evacPointWaitAlert(sent(90, { triage: "black" }), now), null); // except black
  assert.equal(rules.evacPointWaitAlert(sent(90, { patientStatus: "handed_over" }), now), null); // a vehicle took them
  assert.equal(rules.evacPointWaitAlert(sent(90, { patientStatus: "stabilizing" }), now), null);
  assert.equal(rules.evacPointWaitAlert({ patientStatus: "evacuating", triage: "red" }, now), null); // send time unknown
  assert.equal(rules.EVAC_POINT_WAIT_WARN_MS, 30 * 60000);
  assert.equal(rules.EVAC_POINT_WAIT_CRITICAL_MS, 60 * 60000);
}

// WP-31 (owner 2026-11-23): MARCH completion. Treated needs a reassessment; clear is complete with
// no vitals (R and C too); H also needs an AVPU; PAWS is not judged.
{
  const all = (v) => ({ m: v, a: v, r: v, c: v, h: v });
  assert.deepEqual(rules.MARCH_LETTERS, ["m", "a", "r", "c", "h"]);
  // Nothing documented
  let s = rules.marchStatus({}, null);
  assert.equal(s.complete, false);
  assert.deepEqual(s.missing, ["m", "a", "r", "c", "h"]);
  assert.equal(s.letters.m, "not_documented");
  assert.equal(rules.marchStatus(null, "A").letters.a, "not_documented");
  // Treated is not complete until reassessed
  s = rules.marchStatus(all("treated"), "A");
  assert.deepEqual(Object.values(s.letters), Array(5).fill("needs_reassessment"));
  assert.equal(s.complete, false);
  // Effective and clear are complete with an AVPU
  assert.equal(rules.marchStatus(all("effective"), "A").complete, true);
  assert.equal(rules.marchStatus(all("clear"), "U").complete, true);
  // R and C clear need no vitals; only H looks at AVPU
  s = rules.marchStatus(all("clear"), null);
  assert.equal(s.letters.r, "complete");
  assert.equal(s.letters.c, "complete");
  assert.equal(s.letters.h, "needs_avpu");
  assert.deepEqual(s.missing, ["h"]);
  assert.equal(rules.marchStatus({ ...all("clear"), h: "effective" }, "").letters.h, "needs_avpu");
  assert.equal(rules.marchStatus({ ...all("clear"), h: "clear" }, "x").letters.h, "needs_avpu"); // not an AVPU value
  // H treated without AVPU: reassessment is what is asked first
  assert.equal(rules.marchStatus({ h: "treated" }, null).letters.h, "needs_reassessment");
  // Unknown values and PAWS keys are ignored
  assert.equal(rules.marchStatus({ m: "done" }, "A").letters.m, "not_documented");
  assert.equal(rules.marchStatus({ ...all("clear"), p: null, ab: "treated" }, "A").complete, true);
  assert.equal(Object.keys(rules.marchStatus(all("clear"), "A").letters).length, 5);

  // Merge: newest documented value per letter wins; nulls never erase
  const t0 = Date.parse("2026-11-23T10:00:00Z");
  const merged = rules.mergeMarchReviews([
    { at: t0, review: { m: "treated", a: "clear", r: null, c: "clear", h: "clear", p: "treated" } },
    { at: t0 + 60000, review: { m: "effective", a: null } }, // reassessment closes M; A untouched
    { at: t0 + 120000, review: { c: "treated" } }, // a later treatment reopens C
  ]);
  assert.deepEqual(merged, { m: "effective", a: "clear", c: "treated", h: "clear", p: "treated" });
  // Order of entries does not matter, only their time
  assert.deepEqual(
    rules.mergeMarchReviews([{ at: t0 + 5, review: { m: "treated" } }, { at: t0, review: { m: "effective" } }]),
    { m: "treated" }
  );
  // Bad entries are skipped
  assert.deepEqual(rules.mergeMarchReviews([null, { at: "x", review: { m: "clear" } }, { at: t0, review: "m" }, { at: t0, review: { m: "bogus" } }]), {});
  assert.deepEqual(rules.mergeMarchReviews(undefined), {});

  // Owner 2026-11-25: treated wins across phones. A closing save from another source closes a
  // treatment only if its `seen` covers it; clocks are compared only within one source.
  const T = t0;
  // Clock skew: phone A (fast clock) marks C effective without having seen B's later treatment.
  assert.equal(rules.mergeMarchReviews([
    { at: T + 300000, source: "A", review: { c: "effective" }, seen: { c: {} } },
    { at: T + 180000, source: "B", review: { c: "treated" } },
  ]).c, "treated");
  // "Nothing needed" never closes a treatment, even from the same phone, and once a treatment is
  // reassessed a later "nothing needed" keeps the letter "effective" (the treatment stays visible).
  assert.equal(rules.mergeMarchReviews([{ at: T, source: "A", review: { m: "treated" } }, { at: T + 1, source: "A", review: { m: "clear" } }]).m, "treated");
  assert.equal(rules.mergeMarchReviews([
    { at: T, source: "A", review: { m: "treated" } },
    { at: T + 1, source: "A", review: { m: "effective" } },
    { at: T + 2, source: "B", review: { m: "clear" } },
  ]).m, "effective");
  // Stale offline phone: B's "nothing needed" never saw A's M treatment.
  assert.equal(rules.mergeMarchReviews([
    { at: T, source: "A", review: { m: "treated" } },
    { at: T + 60000, source: "B", review: { m: "clear" } },
  ]).m, "treated");
  // B saw A's treatment (seen stamp is A's own clock) and reassessed it: closed.
  assert.equal(rules.mergeMarchReviews([
    { at: T, source: "A", review: { m: "treated" } },
    { at: T - 999999, source: "B", review: { m: "effective" }, seen: { m: { A: T } } }, // B's clock far behind
  ]).m, "effective");
  // ...but a newer A treatment B had not seen reopens it.
  assert.equal(rules.mergeMarchReviews([
    { at: T, source: "A", review: { m: "treated" } },
    { at: T + 1, source: "B", review: { m: "effective" }, seen: { m: { A: T } } },
    { at: T + 5, source: "A", review: { m: "treated" } },
    { at: T + 9, source: "B", review: { m: "effective" }, seen: { m: { A: T } } },
  ]).m, "treated");
  // Same source: its own later save closes its treatment without `seen`.
  assert.equal(rules.mergeMarchReviews([
    { at: T, source: "A", review: { r: "treated" } },
    { at: T + 1, source: "A", review: { r: "effective" } },
  ]).r, "effective");
  // A tourniquet known from elsewhere (its own stable key) needs a closer that saw it.
  const tq = { at: T, source: "tq:left_leg:123", review: { m: "treated" } };
  assert.equal(rules.mergeMarchReviews([tq, { at: T + 1, source: "A", review: { m: "clear" } }]).m, "treated");
  assert.equal(rules.mergeMarchReviews([tq, { at: T + 1, source: "A", review: { m: "effective" }, seen: { m: { "tq:left_leg:123": T } } }]).m, "effective");
  // Aliases: a reassessment that saw the tourniquet under its limb + minute name still covers it once
  // its event key is known; seen records both names.
  const tqEv = { at: 0, source: "tq:dev1:local-1", aliases: ["tq:right_leg:999"], review: { m: "treated" } };
  assert.equal(rules.mergeMarchReviews([tqEv, { at: T, source: "B", review: { m: "effective" }, seen: { m: { "tq:right_leg:999": 0 } } }]).m, "effective");
  assert.deepEqual(rules.marchSeenFrom([tqEv]), { m: { "tq:dev1:local-1": 0 } });
  // Two tourniquets on one limb in one minute share the alias: seeing one never covers the other.
  const tqA = { at: 0, source: "tq:devY:local-A", aliases: ["tq:left_leg:29000000"], review: { m: "treated" } };
  const tqB = { at: 0, source: "tq:devZ:local-B", aliases: ["tq:left_leg:29000000"], review: { m: "treated" } };
  assert.equal(rules.mergeMarchReviews([tqA, tqB, { at: T, source: "X", review: { m: "effective" }, seen: rules.marchSeenFrom([tqA]) }]).m, "treated");
  assert.equal(rules.mergeMarchReviews([tqA, tqB, { at: T, source: "X", review: { m: "effective" }, seen: rules.marchSeenFrom([tqA, tqB]) }]).m, "effective");
  // A seen map's inherited keys never count.
  assert.equal(rules.mergeMarchReviews([{ at: 0, source: "constructor", review: { m: "treated" } }, { at: T, source: "B", review: { m: "effective" }, seen: { m: {} } }]).m, "treated");
  // PAWS letters keep plain newest-wins.
  assert.equal(rules.mergeMarchReviews([{ at: T, source: "A", review: { s: "treated" } }, { at: T + 1, source: "B", review: { s: "clear" } }]).s, "clear");
  // marchSeenFrom: latest treated stamp per source per MARCH letter.
  assert.deepEqual(rules.marchSeenFrom([
    { at: T, source: "A", review: { m: "treated", c: "clear", s: "treated" } },
    { at: T + 7, source: "A", review: { m: "treated" } },
    tq,
    { at: T, source: "B", review: { c: "treated" } },
  ]), { m: { A: T + 7, "tq:left_leg:123": T }, c: { B: T } });
  assert.deepEqual(rules.marchSeenFrom(null), {});
}

console.log("Domain rule tests passed.");
