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

  function needsVitals(patient) {
    if (!patient) return false;
    if (patient.accessibility === "none") return false;
    if (patient.patientStatus === "evacuated") return false;
    if (patient.triage === "black") return false;
    return true;
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
    const lowBP = vitals.bp_estimate === "absent" || vitals.bp_estimate === "carotid";
    const badAVPU = vitals.avpu && vitals.avpu !== "A";
    const badSpo2 = vitals.spo2 && vitals.spo2 < 94;
    if (highRR || lowBP || badAVPU || badSpo2) return "red";
    if (vitals.avpu === "A" && !lowBP && !highRR) return "green";
    return "yellow";
  }

  function suggestMstartTriage({ vitals, sabcde = {}, accessibility } = {}) {
    const v = vitals || {};
    if (v.rr === 0) {
      return { triage: "black", reason: "MCI: לא נושם — מסווג שחור", reasons: [] };
    }
    if (sabcde.B === "abnormal" && sabcde.A !== "managed") {
      return { triage: "black", reason: "ללא נשימה לאחר פתיחת נתיב אוויר", reasons: [] };
    }

    const reasons = [];
    if (v.rr > 30 || (v.rr > 0 && v.rr < 10)) reasons.push(`נשימות ${v.rr}/דקה`);
    if (v.bp_estimate === "absent" || v.bp_estimate === "carotid") reasons.push("לחץ דם ירוד");
    if (v.avpu && v.avpu !== "A") reasons.push(`AVPU ${v.avpu}`);
    if (v.spo2 && v.spo2 < 94) reasons.push(`SpO₂ ${v.spo2}%`);

    if (reasons.length) return { triage: "red", reason: reasons.join(" · "), reasons };
    if (accessibility === "full" && v.avpu === "A") {
      return { triage: "green", reason: "גישה מלאה · מדדים תקינים", reasons: [] };
    }
    return { triage: "yellow", reason: "מדדים בינוניים", reasons: [] };
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

  return {
    AVPU_RANK,
    TOURNIQUET_CRITICAL_MS,
    TOURNIQUET_WARN_MS,
    VITALS_INTERVAL_MS,
    WARN_AT_MS,
    computeMstartTriage,
    detectDeterioration,
    elapsedMinutes,
    isCriticalAlert,
    isRoutineAlert,
    needsVitals,
    suggestMstartTriage,
    timeCodeToTodayMs,
    tourniquetTimer,
    vitalsAgeMs,
    vitalsTimer,
  };
});
