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
  { cls: "", minutes: 30, limb: "right leg" },
);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 45 * 60 * 1000),
  { cls: "notice", minutes: 45, limb: "right leg" },
);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 61 * 60 * 1000),
  { cls: "warn", minutes: 61, limb: "right leg" },
);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 121 * 60 * 1000),
  { cls: "critical", minutes: 121, limb: "right leg" },
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

// FINAL_PATIENT_STATUSES / canChangePatientStatus: once a patient reaches deceased,
// handed_over, evacuated, closed, or self_evacuated, mutation sites (handover, manual
// triage override, sweep color override) must refuse to overwrite them. "evacuating" is
// deliberately not final - a patient waiting at the company collection point under the
// platoon commander's supervision must still be able to reach handed_over.
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

console.log("Domain rule tests passed.");
