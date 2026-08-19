(function initDomainRules(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.C5DomainRules = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function buildDomainRules() {
  "use strict";

  const VITALS_INTERVAL_MS = 5 * 60 * 1000;
  const WARN_AT_MS = 4 * 60 * 1000;
  const TOURNIQUET_WARN_MS = 40 * 60 * 1000;
  const TOURNIQUET_CRITICAL_MS = 60 * 60 * 1000;
  const AVPU_RANK = { A: 0, V: 1, P: 2, U: 3 };
  const PEDIATRIC_AGE_CUTOFF = 8;
  const PEDIATRIC_HIGH_RISK_DOSE_LIMITS = {
    morphine: { max: 4, unit: "mg" },
    fentanyl: { max: 50, unit: "mcg" },
  };
  const VITALS_CLOSED_STATUSES = new Set([
    "closed",
    "deceased",
    "evacuated",
    "evacuating",
    "handed_over",
    "self_evacuated",
  ]);

  function needsVitals(patient) {
    if (!patient) return false;
    if (VITALS_CLOSED_STATUSES.has(patient.patientStatus)) return false;
    if (patient.triage === "black") return false;
    return true;
  }

  function isPediatricPatient(patient = {}) {
    if (patient.patientAge == null || patient.patientAge === "") return patient.patientAgeGroup === "pediatric";
    const age = Number(patient.patientAge);
    return patient.patientAgeGroup === "pediatric" || (Number.isFinite(age) && age < PEDIATRIC_AGE_CUTOFF);
  }

  function isHighRiskDose(medicationName, selectedDose, patient = {}) {
    if (!isPediatricPatient(patient)) return false;
    const key = String(medicationName || "").toLowerCase();
    const limit = PEDIATRIC_HIGH_RISK_DOSE_LIMITS[key];
    const dose = Number(selectedDose);
    if (!limit || !Number.isFinite(dose)) return false;
    const hasAge = patient.patientAge != null && patient.patientAge !== "";
    const age = Number(patient.patientAge);
    const kg = hasAge && Number.isFinite(age) ? Math.max(4, Math.round(age * 2 + 8)) : 4;
    const dynamicMax =
      key === "morphine" ? Math.min(4, Math.max(0.5, kg * 0.1))
      : key === "fentanyl" ? Math.min(50, kg)
      : limit.max;
    return dose > dynamicMax;
  }

  function vitalsAgeMs(patient, nowMs = Date.now()) {
    return nowMs - (patient?.lastVitalsAt || 0);
  }

  function vitalsTimer(patient, nowMs = Date.now()) {
    if (!needsVitals(patient)) return null;
    const age = vitalsAgeMs(patient, nowMs);
    if (age >= VITALS_INTERVAL_MS) {
      return { cls: "overdue", minutes: Math.floor(age / 60000), remainingMinutes: 0 };
    }
    const remainingMinutes = Math.ceil((VITALS_INTERVAL_MS - age) / 60000);
    if (age >= WARN_AT_MS) {
      return { cls: "warn", minutes: Math.floor(age / 60000), remainingMinutes };
    }
    return { cls: "ok", minutes: Math.floor(age / 60000), remainingMinutes };
  }

  function elapsedMinutes(timestamp, nowMs = Date.now()) {
    const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
    return Number.isFinite(parsed) ? Math.max(0, Math.floor((nowMs - parsed) / 60000)) : 0;
  }

  function tourniquetTimer(patient, nowMs = Date.now()) {
    const tourniquet = patient?.tourniquet;
    if (!tourniquet || !tourniquet.appliedAt) return null;
    const elapsedMs = nowMs - tourniquet.appliedAt;
    const minutes = elapsedMinutes(tourniquet.appliedAt, nowMs);
    const cls = elapsedMs >= TOURNIQUET_CRITICAL_MS ? "critical" : elapsedMs >= TOURNIQUET_WARN_MS ? "warn" : "";
    return { cls, minutes, limb: tourniquet.limb || "לא צוין" };
  }

  function timeCodeToTodayMs(code, nowMs = Date.now()) {
    if (!code || !/^\d{4}$/.test(code)) return nowMs;
    const now = new Date(nowMs);
    const day = new Date(nowMs);
    day.setHours(Number(code.slice(0, 2)), Number(code.slice(2)), 0, 0);
    if (day.getTime() > now.getTime() + 60000) day.setDate(day.getDate() - 1);
    return day.getTime();
  }

  function computeMstartTriage(vitals) {
    if (!vitals) return null;
    if (vitals.rr === 0) return "black";
    const highRR = vitals.rr > 30 || (vitals.rr > 0 && vitals.rr < 10);
    const lowBP = vitals.bp_estimate === "absent" || vitals.bp_estimate === "carotid" || vitals.bp_estimate === "carotid_strong" || vitals.bp_estimate === "carotid_weak";
    const weakBP = vitals.bp_estimate === "weak" || vitals.bp_estimate === "radial_weak" || vitals.bp_estimate === "carotid_weak";
    const badAVPU = vitals.avpu && vitals.avpu !== "A";
    const badSpo2 = vitals.spo2 && vitals.spo2 < 94;
    const normalRR = vitals.rr >= 10 && vitals.rr <= 30;
    const hasPerfusion = vitals.bp_estimate === "radial" || vitals.bp_estimate === "radial_strong" || vitals.bp_estimate === "radial_weak";
    if (highRR || lowBP || badAVPU || badSpo2) return "red";
    if (weakBP) return "yellow";
    if (vitals.avpu === "A" && hasPerfusion && normalRR) return "green";
    return "yellow";
  }

  function suggestMstartTriage({ vitals } = {}) {
    const v = vitals || {};
    if (v.rr === 0) {
      return { triage: "black", reason: "MCI: לא נושם — מסווג שחור", reasons: [] };
    }

    const reasons = [];
    if (v.rr > 30 || (v.rr > 0 && v.rr < 10)) reasons.push(`נשימות ${v.rr}/דקה`);
    if (v.bp_estimate === "absent" || v.bp_estimate === "carotid" || v.bp_estimate === "carotid_strong" || v.bp_estimate === "carotid_weak") reasons.push("לחץ דם ירוד");
    if (v.avpu && v.avpu !== "A") reasons.push(`AVPU ${v.avpu}`);
    if (v.spo2 && v.spo2 < 94) reasons.push(`SpO₂ ${v.spo2}%`);

    if (reasons.length) return { triage: "red", reason: reasons.join(" · "), reasons };
    if (v.bp_estimate === "weak" || v.bp_estimate === "radial_weak") return { triage: "yellow", reason: "דופק רדיאלי חלש", reasons: ["פרפוזיה גבולית"] };
    if (v.avpu === "A" && (v.bp_estimate === "radial" || v.bp_estimate === "radial_strong") && v.rr >= 10 && v.rr <= 30) {
      return { triage: "green", reason: "מדדים תקינים · AVPU A", reasons: [] };
    }
    return { triage: "yellow", reason: "מידע חלקי / מדדים בינוניים — לא מסווג אוטומטית כירוק", reasons: [] };
  }

  function suggestedSweepColor(m = {}) {
    if (m.overrideReason && m.color) return m.color;
    if (m.lifeThreateningHemorrhage) return "red";
    if (m.walking === "yes") return "green";
    if (m.breathing === "no") return m.airwayOpened && m.breathingAfterAirway === "no" ? "black" : "red";
    if (m.perfusion === "absent") return "black";
    if (["carotid_only", "radial_weak"].includes(m.perfusion)) return "red";
    if (["V", "P", "U"].includes(m.avpu)) return "red";
    if (["trapped", "immobile"].includes(m.trapped)) return "yellow";
    if (m.breathing === "yes" && m.perfusion === "radial_strong" && m.avpu === "A") return "yellow";
    return "yellow";
  }

  function detectDeterioration(prev = {}, next = {}) {
    const flags = [];
    if (next.spo2 && prev.spo2 && next.spo2 <= prev.spo2 - 5) {
      flags.push(`⬇ SpO₂ ${prev.spo2}→${next.spo2}%`);
    }
    if (next.avpu && prev.avpu && AVPU_RANK[next.avpu] > AVPU_RANK[prev.avpu]) {
      flags.push(`⬇ AVPU ${prev.avpu}→${next.avpu}`);
    }
    if (Number.isFinite(next.pulse) && Number.isFinite(prev.pulse) && Math.abs(next.pulse - prev.pulse) >= 25) {
      flags.push(`⚡ דופק ${prev.pulse}→${next.pulse}`);
    }
    return flags;
  }

  function isRoutineAlert(patient, nowMs = Date.now()) {
    return needsVitals(patient) && vitalsAgeMs(patient, nowMs) >= VITALS_INTERVAL_MS;
  }

  function isCriticalAlert(patient) {
    return !!(patient && (patient.alert || (patient.deterioration && patient.deterioration.length)));
  }

  // Statuses a patient's record must not be silently overwritten out of once reached.
  // Deliberately excludes "evacuating": a patient who has left the site for the company
  // collection point is still under the platoon commander's supervision awaiting final
  // handover to MDA, so status must still be able to advance from there to "handed_over".
  const FINAL_PATIENT_STATUSES = new Set([
    "closed",
    "deceased",
    "evacuated",
    "handed_over",
    "self_evacuated",
  ]);

  function isFinalPatientStatus(status) {
    return FINAL_PATIENT_STATUSES.has(status);
  }

  // Guard for anything that mutates an already-saved patient's triage/status/handover
  // fields (handover, manual triage override, sweep color override, life-saving-treatment
  // logging). Once a patient is in a final status, those actions must no-op rather than
  // silently overwrite it. The one sanctioned exception (undoing a suspected-not-salvageable
  // black call) is deliberately not routed through this guard - it checks its own
  // narrower condition instead.
  function canChangePatientStatus(patient) {
    return !isFinalPatientStatus(patient?.patientStatus);
  }

  return {
    AVPU_RANK,
    FINAL_PATIENT_STATUSES,
    TOURNIQUET_CRITICAL_MS,
    TOURNIQUET_WARN_MS,
    VITALS_INTERVAL_MS,
    WARN_AT_MS,
    canChangePatientStatus,
    computeMstartTriage,
    detectDeterioration,
    elapsedMinutes,
    isCriticalAlert,
    isFinalPatientStatus,
    isHighRiskDose,
    isPediatricPatient,
    isRoutineAlert,
    needsVitals,
    PEDIATRIC_AGE_CUTOFF,
    PEDIATRIC_HIGH_RISK_DOSE_LIMITS,
    suggestedSweepColor,
    suggestMstartTriage,
    timeCodeToTodayMs,
    tourniquetTimer,
    vitalsAgeMs,
    vitalsTimer,
  };
});
