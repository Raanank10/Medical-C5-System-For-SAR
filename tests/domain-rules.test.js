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
assert.equal(rules.needsVitals(patient({ accessibility: "none" })), false);
assert.equal(rules.needsVitals(patient({ patientStatus: "evacuated" })), false);
assert.equal(rules.needsVitals(patient({ patientStatus: "evacuating" })), false);
assert.equal(rules.needsVitals(patient({ patientStatus: "deceased" })), false);
assert.equal(rules.needsVitals(patient({ patientStatus: "handed_over" })), false);
assert.equal(rules.needsVitals(patient({ triage: "black" })), false);

assert.deepEqual(rules.vitalsTimer(patient(), baseTime + 2 * 60 * 1000), {
  cls: "ok",
  minutes: 2,
  remainingMinutes: 3,
});
assert.deepEqual(rules.vitalsTimer(patient(), baseTime + 4 * 60 * 1000), {
  cls: "warn",
  minutes: 4,
  remainingMinutes: 1,
});
assert.deepEqual(rules.vitalsTimer(patient(), baseTime + 7 * 60 * 1000), {
  cls: "overdue",
  minutes: 7,
  remainingMinutes: 0,
});

assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 41 * 60 * 1000),
  { cls: "warn", minutes: 41, limb: "right leg" },
);
assert.deepEqual(
  rules.tourniquetTimer(patient({ tourniquet: { limb: "right leg", appliedAt: baseTime } }), baseTime + 61 * 60 * 1000),
  { cls: "critical", minutes: 61, limb: "right leg" },
);

assert.equal(rules.computeMstartTriage({ rr: 0 }), "black");
assert.equal(rules.computeMstartTriage({ rr: 34, bp_estimate: "radial", avpu: "A", spo2: 98 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "absent", avpu: "A", spo2: 98 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial", avpu: "V", spo2: 98 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial", avpu: "A", spo2: 91 }), "red");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: "radial", avpu: "A", spo2: 98 }), "green");
assert.equal(rules.computeMstartTriage({ rr: 16, bp_estimate: null, avpu: null, spo2: null }), "yellow");

assert.deepEqual(
  rules.suggestMstartTriage({ vitals: { rr: 16, bp_estimate: "radial", avpu: "A", spo2: 98 }, accessibility: "full" }),
  { triage: "green", reason: "גישה מלאה · מדדים תקינים", reasons: [] },
);
assert.equal(
  rules.suggestMstartTriage({ vitals: { rr: 16 }, sabcde: { A: "blocked", B: "abnormal" } }).triage,
  "black",
);
assert.equal(
  rules.suggestMstartTriage({ vitals: { rr: 8, bp_estimate: "carotid", avpu: "P", spo2: 90 } }).triage,
  "red",
);

assert.deepEqual(
  rules.detectDeterioration({ pulse: 100, spo2: 98, avpu: "A" }, { pulse: 70, spo2: 92, avpu: "P" }),
  ["⬇ SpO₂ 98→92%", "⬇ AVPU A→P", "⚡ דופק 100→70"],
);

console.log("Domain rule tests passed.");
