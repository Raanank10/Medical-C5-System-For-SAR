(function initDomainRules(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.C5DomainRules = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function buildDomainRules() {
  "use strict";

  // Vitals reassessment interval varies by triage color - higher acuity gets checked more
  // often. A patient with no/unset triage yet (freshly created, not yet MSTART-triaged)
  // defaults to the red interval: most conservative until an actual color is known.
  const VITALS_INTERVAL_MS_BY_TRIAGE = {
    red: 10 * 60 * 1000,
    yellow: 20 * 60 * 1000,
    green: 30 * 60 * 1000,
  };
  const VITALS_WARN_BUFFER_MS = 60 * 1000;
  // Tourniquet review thresholds, correctly at 60m/120m (this used to disagree with a second,
  // independent implementation in index.html's command-view watchdog panel, which already had
  // the right numbers - see computeWatchdogRows). TOURNIQUET_NOTICE_MS is an early heads-up for
  // the medic, well before the 60-minute review point actually arrives.
  const TOURNIQUET_NOTICE_MS = 45 * 60 * 1000;
  const TOURNIQUET_WARN_MS = 60 * 60 * 1000;
  const TOURNIQUET_CRITICAL_MS = 120 * 60 * 1000;
  const DEVICE_SILENCE_MS = 10 * 60 * 1000;
  // Inventory burn-rate / stock-out risk, matching the KPI definitions in
  // docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md ("Supply burn rate: items consumed per 10m",
  // "Stock-out risk: current stock / recent burn rate"). A warning-tier count is flagged well
  // before it's actually critical - critical defaults to 40% of the warning threshold unless a
  // specific value is given for that item.
  const SUPPLY_BURN_WINDOW_MS = 10 * 60 * 1000;
  const SUPPLY_CRITICAL_RATIO = 0.4;
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

  function vitalsIntervalMsFor(triage) {
    return VITALS_INTERVAL_MS_BY_TRIAGE[triage] || VITALS_INTERVAL_MS_BY_TRIAGE.red;
  }

  function isVitalsOverdue(patient, nowMs = Date.now()) {
    return needsVitals(patient) && vitalsAgeMs(patient, nowMs) >= vitalsIntervalMsFor(patient?.triage);
  }

  function vitalsTimer(patient, nowMs = Date.now()) {
    if (!needsVitals(patient)) return null;
    const intervalMs = vitalsIntervalMsFor(patient.triage);
    const age = vitalsAgeMs(patient, nowMs);
    if (age >= intervalMs) {
      return { cls: "overdue", minutes: Math.floor(age / 60000), remainingMinutes: 0 };
    }
    const remainingMinutes = Math.ceil((intervalMs - age) / 60000);
    if (age >= intervalMs - VITALS_WARN_BUFFER_MS) {
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
    const cls =
      elapsedMs >= TOURNIQUET_CRITICAL_MS ? "critical"
      : elapsedMs >= TOURNIQUET_WARN_MS ? "warn"
      : elapsedMs >= TOURNIQUET_NOTICE_MS ? "notice"
      : "";
    return { cls, minutes, limb: tourniquet.limb || "לא צוין" };
  }

  function isDeviceSilent(lastSeenMs, nowMs = Date.now()) {
    return !lastSeenMs || nowMs - lastSeenMs > DEVICE_SILENCE_MS;
  }

  function supplyCriticalThreshold(warningThreshold) {
    return Math.max(0, Math.round(warningThreshold * SUPPLY_CRITICAL_RATIO));
  }

  function supplyRiskTier(remaining, warningThreshold, criticalThreshold) {
    if (remaining <= criticalThreshold) return "critical";
    if (remaining <= warningThreshold) return "warning";
    return "ok";
  }

  // events: local event log entries (state.localEvents), each shaped like
  // {type, local_timestamp, payload_json:{item_type|item, quantity_delta}} - as emitted by
  // consumeFieldSupply()/reconcileSupplySource() in index.html. Counts only real consumption
  // (negative quantity_delta) inside the trailing 10-minute window; restocks/corrections don't
  // count as burn.
  function supplyBurnRatePer10Min(events, itemType, nowMs = Date.now()) {
    const windowStart = nowMs - SUPPLY_BURN_WINDOW_MS;
    return (events || []).reduce((sum, e) => {
      if (e.type !== "SUPPLY_CONSUMED") return sum;
      const payload = e.payload_json || {};
      if ((payload.item_type || payload.item) !== itemType) return sum;
      const ts = typeof e.local_timestamp === "string" ? Date.parse(e.local_timestamp) : e.local_timestamp;
      if (!Number.isFinite(ts) || ts < windowStart || ts > nowMs) return sum;
      const delta = Number(payload.quantity_delta) || 0;
      return delta < 0 ? sum + Math.abs(delta) : sum;
    }, 0);
  }

  // "Current stock / recent burn rate" per the spec, expressed in minutes. Returns null when
  // there's no recent consumption to extrapolate from (an idle burn rate says nothing about
  // when stock will run out, not that it never will).
  function minutesToStockout(remaining, burnRatePer10Min) {
    if (!Number.isFinite(burnRatePer10Min) || burnRatePer10Min <= 0) return null;
    return Math.max(0, Math.round((remaining / burnRatePer10Min) * 10));
  }

  // Alerting policy on top of the KPI numbers above: flag "critical" once stock is already at/
  // below the critical threshold or projected to run out within 15 minutes at the current pace;
  // "warning" at the warning threshold or a 30-minute projection. Both horizons are deliberately
  // adjustable - not part of the KPI definition itself, just when it's worth surfacing.
  function supplyBurnAlertLevel({ remaining, warningThreshold, criticalThreshold, minutesToStockout: minsToZero }) {
    const isCritical = remaining <= criticalThreshold || (minsToZero != null && minsToZero <= 15);
    const isWarning = remaining <= warningThreshold || (minsToZero != null && minsToZero <= 30);
    if (isCritical) return "CRITICAL";
    if (isWarning) return "HIGH";
    return null;
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
    return isVitalsOverdue(patient, nowMs);
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
    DEVICE_SILENCE_MS,
    FINAL_PATIENT_STATUSES,
    SUPPLY_BURN_WINDOW_MS,
    SUPPLY_CRITICAL_RATIO,
    TOURNIQUET_CRITICAL_MS,
    TOURNIQUET_NOTICE_MS,
    TOURNIQUET_WARN_MS,
    VITALS_INTERVAL_MS_BY_TRIAGE,
    VITALS_WARN_BUFFER_MS,
    canChangePatientStatus,
    computeMstartTriage,
    detectDeterioration,
    elapsedMinutes,
    isCriticalAlert,
    isDeviceSilent,
    isFinalPatientStatus,
    isHighRiskDose,
    isPediatricPatient,
    isRoutineAlert,
    isVitalsOverdue,
    minutesToStockout,
    needsVitals,
    PEDIATRIC_AGE_CUTOFF,
    PEDIATRIC_HIGH_RISK_DOSE_LIMITS,
    suggestedSweepColor,
    suggestMstartTriage,
    supplyBurnAlertLevel,
    supplyBurnRatePer10Min,
    supplyCriticalThreshold,
    supplyRiskTier,
    timeCodeToTodayMs,
    tourniquetTimer,
    vitalsAgeMs,
    vitalsIntervalMsFor,
    vitalsTimer,
  };
});
