// C5 Sentinel-SAR /sync/log - implements docs/API_SURFACE_v1.2.md sections 2 & 3.
// Deployed as a Supabase Edge Function (invocation path is /functions/v1/sync-log,
// not literally /sync/log - there is no custom domain/reverse proxy in front of
// this project). POST = push, GET = pull, routed by req.method.
//
// Design notes:
// - Runs as the CALLING USER (their own JWT), not service_role, for the actual
//   events insert/select - this means the events_insert_by_role /
//   events_read_authenticated RLS policies (already built and verified with real
//   accounts this session) are the real enforcement, not duplicated logic here.
// - A service_role client is used ONLY for writes to sync_ingestion_errors, which
//   has no INSERT policy for authenticated users by design (it's meant to be
//   system-populated, matching the same pattern as watchdog_alerts/tourniquets).
// - events_insert_by_role's role-based clause is effectively a no-op (see
//   ROLE_ALLOWED_EVENT_TYPES below) - the caller's real profiles.role is looked
//   up and checked against event type here, since the RLS policy doesn't
//   actually do this.
// - Each event is inserted as its own independent Postgres statement (implicit
//   autocommit), matching the spec's "not one all-or-nothing transaction"
//   requirement - one event's failure doesn't roll back or block the rest.
// - high_risk_flags are read back from watchdog_alerts (payload_json->>'event_id')
//   after insert, not reimplemented here - the DB triggers already own that
//   logic (flag_pediatric_medication_missing_weight, trg_verify_pediatric_safety)
//   and reimplementing it here would risk exactly the kind of drift this session
//   already found and fixed once for the SABCDE branch.
// - field_conflicts (F3, docs/CONFLICT_RESOLUTION_DECISION.md) are read back from
//   conflict_log the same way, keyed off the just-inserted event's id appearing as
//   either the winning or losing side in that row's payload_json - the role-authority
//   tie-break logic itself lives entirely in project_patient_state() (database/021),
//   not here.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Source of truth: docs/ROLE_COMMAND_MODEL_v2.7.md + v2.8.md and the in-app
// AUTH_MATRIX. Deliberately grouped by category rather than 60x8 exhaustive -
// default is DENY for anything not listed. admin always allowed (checked
// separately below).
const CLINICAL_EVENTS = [
  "PATIENT_CREATED", "QUICK_PATIENT_CREATED", "PATIENT_IDENTIFIED",
  "PATIENT_INJURY_UPDATED", "PATIENT_LOCATION_UPDATED", "PATIENT_ACCESS_UPDATED",
  "PATIENT_TRIAGE_UPDATED", "PATIENT_STATUS_UPDATED", "PATIENT_T_INJURY_UPDATED",
  "PATIENT_HANDED_OVER", "PATIENT_TRIAGED_EXPECTANT", "VITALS_RECORDED",
  "MINIMAL_TRIAGE_RECORDED", "SABCDE_RECORDED", "MSTART_SUGGESTED",
  "JUMPSTART_SUGGESTED", "MSTART_OVERRIDE", "JUMPSTART_OVERRIDE",
  "TOURNIQUET_APPLIED", "TOURNIQUET_REASSESSMENT", "TOURNIQUET_RELEASED",
  "TOURNIQUET_CONTEXT_UPDATED", "INTERVENTION_RECORDED", "MEDICATION_ADMINISTERED",
  "AIRWAY_MANAGED", "HIGH_RISK_OVERRIDE_CONFIRMED",
];
const FIRST_RESPONDER_EVENTS = ["FIRST_RESPONDER_REPORT"];
// Event types that create a new patients row on first sight (idempotent — see handlePush).
// FIRST_RESPONDER_REPORT is included because it's rpc/rcc's only patient-creating event type;
// they're never allowed to write PATIENT_CREATED/QUICK_PATIENT_CREATED (see
// ROLE_ALLOWED_EVENT_TYPES below), so without this they could never create a patient at all
// despite patients_insert RLS explicitly granting them that.
const PATIENT_CREATE_EVENT_TYPES = ["PATIENT_CREATED", "QUICK_PATIENT_CREATED", "FIRST_RESPONDER_REPORT"];
const SITE_AUTHORITY_EVENTS = [
  "OFFICIAL_INCIDENT_OPENED_BY_RESCUE", "INCIDENT_CLOSE_TOGGLED",
  "BUILDING_STATUS_UPDATED", "SITE_CLEAR_CONFIRMED",
];
const INCIDENT_COMMAND_EVENTS = [
  "INCIDENT_DRAFT_CREATED", "INCIDENT_OPENED", "INCIDENT_CONFIRMED",
  "INCIDENT_DRAFT_MERGED", "INCIDENT_DRAFT_REJECTED", "INCIDENT_CLOSED",
  "INCIDENT_REOPENED", "MEDIC_SITE_CLOSE_REQUESTED",
];
const SUPPLY_LOGISTICS_EVENTS = [
  "SUPPLY_REQUEST_CREATED", "SUPPLY_REQUEST_DISPATCHED", "SUPPLY_REQUEST_IN_TRANSIT",
  "SUPPLY_REQUEST_RECEIVED", "INVENTORY_LEDGER_ENTRY", "INVENTORY_INITIALIZED",
  "INVENTORY_TRANSFER_OUT", "INVENTORY_TRANSFER_IN", "PLATOON_STOCK_INITIALIZED",
  "PLATOON_STOCK_REFILLED", "DIRECT_LOGO_TO_MEDIC_REFILL",
  // The following are the event type strings index.html's real supply/resupply
  // flow actually emits (consumeFieldSupply, receiveLogisticsSupply,
  // submitMedicResupplyRequest, updateResupplyStatus) - they were missing from
  // this list entirely, which meant isEventTypeAllowed() default-denied every
  // one of them and the whole field supply-consumption/resupply pipeline was
  // quarantined (FORBIDDEN_ACTOR_ROLE) on push instead of syncing.
  "SUPPLY_CONSUMED", "SUPPLY_USE_CANCELLED", "INVENTORY_LEDGER_MOVEMENT",
  "LOCAL_STOCKOUT_WARNING", "RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE",
  "RESUPPLY_REQUEST_ESCALATED_CC", "RESUPPLY_APPROVED_FROM_PC_TRUCK",
  "PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED", "RESUPPLY_ESCALATED_TO_CC",
];
const EXTERNAL_REPORT_EVENTS = ["EXTERNAL_REPORT_CREATED", "EXTERNAL_REPORT_LINKED"];
// Real physician-only clinical death confirmation (docs/CONFLICT_RESOLUTION_DECISION.md's
// "Official death certification" section) - deliberately its own array, not folded into
// CLINICAL_EVENTS, since CLINICAL_EVENTS is shared by medic/pc/paramedic/physician and
// including it there would defeat the physician-only intent at this layer. The real
// database-level enforcement is death_confirmations' own physician-only RLS INSERT policy
// (database/025) - this array is defense in depth, not the sole gate.
const PHYSICIAN_ONLY_EVENTS = ["PATIENT_DEATH_CONFIRMED"];
// System/audit-adjacent - acknowledgment and note events are intentionally
// not tightly gated; over-restricting these blocks legitimate cross-role
// coordination for little safety benefit.
const SYSTEM_EVENTS = [
  "WATCHDOG_ALERT", "WATCHDOG_ACKNOWLEDGED", "WATCHDOG_RESOLVED",
  "DEAD_MAN_SWITCH_ESCALATED", "SYNC_CONFLICT", "CONFLICT_LOG_ENTRY",
  "TREATMENT_SAFETY_WARNING", "COMMAND_CONTEXT_NOTE_ADDED", "VOICE_MEMO_ADDED",
  "HIGH_RISK_CLINICAL_VIOLATION", "NOTE_ADDED", "AAR_CONTEXT_NOTE_ADDED",
];

// Field supply-consumption event types medic/paramedic actually emit while
// treating patients (consumeFieldSupply/showOwnInventory in index.html) and
// while requesting resupply from the PC truck (submitMedicResupplyRequest) -
// listed individually rather than spreading SUPPLY_LOGISTICS_EVENTS, since
// medic/paramedic never approve/dispatch/transfer stock, only consume it and
// request more.
const MEDIC_SUPPLY_EVENTS = [
  "SUPPLY_REQUEST_CREATED", "SUPPLY_CONSUMED", "SUPPLY_USE_CANCELLED",
  "INVENTORY_LEDGER_MOVEMENT", "LOCAL_STOCKOUT_WARNING",
  "RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE", "RESUPPLY_REQUEST_ESCALATED_CC",
];

const ROLE_ALLOWED_EVENT_TYPES: Record<string, string[]> = {
  medic: [...CLINICAL_EVENTS, ...FIRST_RESPONDER_EVENTS, "INCIDENT_DRAFT_CREATED", "MEDIC_SITE_CLOSE_REQUESTED", ...MEDIC_SUPPLY_EVENTS, ...SYSTEM_EVENTS],
  pc: [...CLINICAL_EVENTS, ...FIRST_RESPONDER_EVENTS, ...INCIDENT_COMMAND_EVENTS, ...SITE_AUTHORITY_EVENTS, ...SUPPLY_LOGISTICS_EVENTS, ...EXTERNAL_REPORT_EVENTS, ...SYSTEM_EVENTS],
  cc: [...INCIDENT_COMMAND_EVENTS, ...SITE_AUTHORITY_EVENTS, ...SUPPLY_LOGISTICS_EVENTS, ...EXTERNAL_REPORT_EVENTS, ...SYSTEM_EVENTS],
  chamal: [...INCIDENT_COMMAND_EVENTS, ...SITE_AUTHORITY_EVENTS, ...EXTERNAL_REPORT_EVENTS, ...SYSTEM_EVENTS],
  logistics_officer: [...SUPPLY_LOGISTICS_EVENTS, ...SYSTEM_EVENTS],
  rpc: [...FIRST_RESPONDER_EVENTS, ...SITE_AUTHORITY_EVENTS, ...SYSTEM_EVENTS],
  rcc: [...FIRST_RESPONDER_EVENTS, ...SITE_AUTHORITY_EVENTS, ...SUPPLY_LOGISTICS_EVENTS.filter((t) => t === "SUPPLY_REQUEST_CREATED"), ...SYSTEM_EVENTS],
  // Not a literal mirror of cc: cc itself has no CLINICAL_EVENTS access today,
  // which would leave physician unable to write PATIENT_TRIAGE_UPDATED/
  // PATIENT_STATUS_UPDATED and defeat the point of the F3 role-authority
  // tie-break (docs/CONFLICT_RESOLUTION_DECISION.md). physician = cc's full
  // command-adjacent scope plus medic/pc-level clinical write access.
  physician: [...CLINICAL_EVENTS, ...FIRST_RESPONDER_EVENTS, ...INCIDENT_COMMAND_EVENTS, ...SITE_AUTHORITY_EVENTS, ...SUPPLY_LOGISTICS_EVENTS, ...EXTERNAL_REPORT_EVENTS, ...SYSTEM_EVENTS, ...PHYSICIAN_ONLY_EVENTS],
  // Exact mirror of medic's scope - paramedic is a clinical-seniority tier
  // for the F3 tie-break, not a different set of app capabilities.
  paramedic: [...CLINICAL_EVENTS, ...FIRST_RESPONDER_EVENTS, "INCIDENT_DRAFT_CREATED", "MEDIC_SITE_CLOSE_REQUESTED", ...MEDIC_SUPPLY_EVENTS, ...SYSTEM_EVENTS],
};

function isEventTypeAllowed(role: string, type: string): boolean {
  if (role === "admin") return true;
  return (ROLE_ALLOWED_EVENT_TYPES[role] ?? []).includes(type);
}

interface IncomingEvent {
  local_event_id: string;
  type: string;
  patient_id?: string | null;
  actor_role?: string;
  local_timestamp: string;
  payload_json?: Record<string, unknown>;
  depends_on?: { device_id: string; local_event_id: string }[];
}

// Structured logging (docs/OBSERVABILITY_REVIEW.md): one JSON line per real decision point,
// captured for free by Supabase's already-running edge_logs tier - no new dependency, no new
// service. Never log patient names, free-text clinical fields, or event payload_json bodies -
// counts, codes, ids, and roles only, matching this schema's existing privacy-minimization
// stance (docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md).
function logEvent(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, fn: "sync-log", ...fields }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "missing_authorization" }, 401);
    }

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "invalid_session" }, 401);
    }
    const callerId = userData.user.id;

    const { data: profile, error: profileErr } = await userClient
      .from("profiles")
      .select("role, is_active")
      .eq("id", callerId)
      .single();
    if (profileErr || !profile || !profile.is_active) {
      logEvent("no_active_profile", { caller_id: callerId, method: req.method });
      return json({ error: "no_active_profile" }, 403);
    }
    const callerRole = profile.role as string;

    if (req.method === "POST") {
      return await handlePush(req, userClient, serviceClient, callerId, callerRole);
    }
    if (req.method === "GET") {
      return await handlePull(req, userClient, callerId);
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    // Anything unexpected (auth-provider blip, thrown exception before any earlier catch) -
    // previously silently became a bare 500 with no record anywhere. Logged, not just returned.
    logEvent("unhandled_exception", { method: req.method, message: e instanceof Error ? e.message : String(e) });
    return json({ error: "internal_error" }, 500);
  }
});

async function handlePush(
  req: Request,
  // deno-lint-ignore no-explicit-any
  userClient: any,
  // deno-lint-ignore no-explicit-any
  serviceClient: any,
  callerId: string,
  callerRole: string,
): Promise<Response> {
  let body: {
    device_id?: string;
    incident_id?: string;
    last_known_server_cursor?: number;
    last_pull_cursor?: number;
    events?: IncomingEvent[];
  };
  try {
    body = await req.json();
  } catch {
    logEvent("invalid_json_body", { caller_id: callerId, role: callerRole });
    return json({ error: "invalid_json_body" }, 400);
  }

  const { device_id, incident_id, events } = body;
  if (!device_id || !Array.isArray(events)) {
    logEvent("missing_device_id_or_events", { caller_id: callerId, role: callerRole, incident_id: incident_id ?? null });
    return json({ error: "missing_device_id_or_events" }, 400);
  }

  const accepted: Record<string, unknown>[] = [];
  const duplicates: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];
  const blocked_dependency: Record<string, unknown>[] = [];
  const high_risk_flags: Record<string, unknown>[] = [];
  const field_conflicts: Record<string, unknown>[] = [];
  const acceptedInBatch = new Set<string>();

  async function quarantine(evt: Partial<IncomingEvent>, code: string, message: string, dependency?: { device_id: string; local_event_id: string }) {
    await serviceClient.from("sync_ingestion_errors").insert({
      incident_id: incident_id ?? null,
      device_id,
      actor_id: callerId,
      local_event_id: evt.local_event_id ?? null,
      error_code: code,
      error_message: message,
      raw_payload: evt as unknown as Record<string, unknown>,
      retryable: code === "BLOCKED_DEPENDENCY",
      ...(dependency
        ? {
          dependency_status: "blocked_dependency",
          parent_device_id: dependency.device_id,
          parent_local_event_id: dependency.local_event_id,
        }
        : {}),
    });
  }

  for (const evt of events) {
    const { local_event_id, type, patient_id, local_timestamp, payload_json, depends_on } = evt;

    if (!local_event_id || !type || !local_timestamp) {
      rejected.push({
        local_event_id: local_event_id ?? null,
        terminal: true,
        error_code: "MALFORMED_EVENT_ENVELOPE",
        message: "Missing required field(s): local_event_id, type, local_timestamp.",
      });
      await quarantine(evt, "MALFORMED_EVENT_ENVELOPE", "Missing required envelope field(s).");
      continue;
    }

    if (!isEventTypeAllowed(callerRole, type)) {
      rejected.push({
        local_event_id,
        terminal: true,
        error_code: "FORBIDDEN_ACTOR_ROLE",
        message: `Role '${callerRole}' is not permitted to write event type '${type}'.`,
      });
      await quarantine(evt, "FORBIDDEN_ACTOR_ROLE", `Role '${callerRole}' cannot write '${type}'.`);
      continue;
    }

    if (Array.isArray(depends_on) && depends_on.length > 0) {
      let blocked: { device_id: string; local_event_id: string } | null = null;
      for (const dep of depends_on) {
        if (dep.device_id === device_id && acceptedInBatch.has(dep.local_event_id)) continue;
        const { data: parentRows } = await userClient
          .from("events")
          .select("id")
          .eq("device_id", dep.device_id)
          .eq("local_event_id", dep.local_event_id)
          .limit(1);
        if (!parentRows || parentRows.length === 0) {
          blocked = dep;
          break;
        }
      }
      if (blocked) {
        blocked_dependency.push({
          local_event_id,
          parent_local_event_id: blocked.local_event_id,
          reason: "parent_rejected_or_quarantined",
        });
        await quarantine(evt, "BLOCKED_DEPENDENCY", `Depends on ${blocked.device_id}/${blocked.local_event_id}, not present.`, blocked);
        continue;
      }
    }

    // events.patient_id is a uuid FK to patients(id), enforced immediately (not deferred) - if
    // this event is one of the ones that's supposed to create a patient, the row must exist
    // BEFORE the events insert below, or the FK fails. Runs via userClient (never serviceClient)
    // so the real patients_insert RLS policy is what actually gates this, not duplicated logic
    // here - matches this file's existing pattern for the events insert itself.
    if (PATIENT_CREATE_EVENT_TYPES.includes(type) && patient_id) {
      const visualId = (payload_json?.visual_id as string | undefined)
        ?? (payload_json?.visualId as string | undefined)
        ?? local_event_id;
      const { error: patientErr } = await userClient.from("patients").insert({
        id: patient_id,
        incident_id: incident_id ?? null,
        visual_id: visualId,
        // No real injury-time capture client-side yet - falling back to this event's own
        // timestamp is a known, documented gap (see docs/API_SURFACE_v1.2.md), not a silent one.
        t_injury: local_timestamp,
        created_by: callerId,
      });
      // 23505 = unique violation - same patient_id (or incident_id+visual_id) already created,
      // e.g. a retried push. Treat as idempotent success, not an error.
      if (patientErr && patientErr.code !== "23505") {
        rejected.push({
          local_event_id,
          terminal: false,
          error_code: "PATIENT_CREATE_FAILED",
          message: patientErr.message,
        });
        await quarantine(evt, "PATIENT_CREATE_FAILED", patientErr.message);
        continue; // skip this event's insert below - the FK would fail anyway
      }
    }

    const insertRow = {
      incident_id: incident_id ?? null,
      patient_id: patient_id ?? null,
      actor_id: callerId,
      actor_role: callerRole,
      type,
      payload_json: payload_json ?? {},
      device_id,
      local_event_id,
      local_timestamp,
    };

    const { data: inserted, error: insertErr } = await userClient
      .from("events")
      .insert(insertRow)
      .select("id, sync_cursor")
      .single();

    if (!insertErr) {
      accepted.push({
        local_event_id,
        server_event_id: inserted.id,
        server_cursor: inserted.sync_cursor,
      });
      acceptedInBatch.add(local_event_id);

      const { data: alerts } = await userClient
        .from("watchdog_alerts")
        .select("alert_type, severity, message")
        .eq("payload_json->>event_id", inserted.id);
      for (const alert of alerts ?? []) {
        high_risk_flags.push({
          local_event_id,
          severity: alert.severity,
          code: alert.alert_type,
          message: alert.message,
        });
      }

      // F3 (docs/CONFLICT_RESOLUTION_DECISION.md): let the acting device know right away if
      // its own just-pushed edit won or lost a role-authority tie-break, mirroring the
      // high_risk_flags pattern above rather than making the device wait for a periodic pull.
      const { data: conflicts } = await userClient
        .from("conflict_log")
        .select("payload_json, description")
        .eq("conflict_type", "PATIENT_FIELD_CONFLICT_DETECTED")
        .or(`payload_json->>winning_event_id.eq.${inserted.id},payload_json->>losing_event_id.eq.${inserted.id}`);
      for (const conflict of conflicts ?? []) {
        const payload = conflict.payload_json as Record<string, unknown> | null;
        field_conflicts.push({
          local_event_id,
          field: payload?.field ?? null,
          won: payload?.winning_event_id === inserted.id,
          winning_role: payload?.winning_role ?? null,
          losing_role: payload?.losing_role ?? null,
          message: conflict.description,
        });
      }
      continue;
    }

    if (insertErr.code === "23505") {
      const { data: existing } = await userClient
        .from("events")
        .select("id, sync_cursor")
        .eq("device_id", device_id)
        .eq("local_event_id", local_event_id)
        .single();
      duplicates.push({
        local_event_id,
        server_event_id: existing?.id ?? null,
        server_cursor: existing?.sync_cursor ?? null,
      });
      continue;
    }

    const isRlsDenied = insertErr.code === "42501" || /row-level security/i.test(insertErr.message ?? "");
    rejected.push({
      local_event_id,
      terminal: isRlsDenied,
      error_code: isRlsDenied ? "FORBIDDEN_ACTOR_ROLE" : "MALFORMED_EVENT_ENVELOPE",
      message: insertErr.message,
    });
    await quarantine(evt, isRlsDenied ? "FORBIDDEN_ACTOR_ROLE" : "MALFORMED_EVENT_ENVELOPE", insertErr.message);
  }

  const cursors = [...accepted, ...duplicates]
    .map((e) => e.server_cursor as number | null)
    .filter((c): c is number => c != null);
  const next_pull_cursor = cursors.length > 0
    ? Math.max(...cursors)
    : (body.last_known_server_cursor ?? body.last_pull_cursor ?? null);

  logEvent("push_batch_completed", {
    device_id,
    incident_id: incident_id ?? null,
    caller_id: callerId,
    role: callerRole,
    batch_size: events.length,
    accepted: accepted.length,
    duplicates: duplicates.length,
    rejected: rejected.length,
    blocked_dependency: blocked_dependency.length,
    high_risk_flags: high_risk_flags.length,
    field_conflicts: field_conflicts.length,
  });

  return json({
    server_time: new Date().toISOString(),
    accepted,
    duplicates,
    rejected,
    blocked_dependency,
    high_risk_flags,
    field_conflicts,
    next_pull_cursor,
  });
}

// deno-lint-ignore no-explicit-any
async function handlePull(req: Request, userClient: any, callerId: string): Promise<Response> {
  const url = new URL(req.url);
  const incident_id = url.searchParams.get("incident_id");
  const since_cursor = Number(url.searchParams.get("since_cursor") ?? "0");
  const limitParam = Number(url.searchParams.get("limit") ?? "500");
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 500, 1), 2000);

  if (!incident_id) {
    logEvent("missing_incident_id", { caller_id: callerId });
    return json({ error: "missing_incident_id" }, 400);
  }

  const { data, error } = await userClient
    .from("events")
    .select("sync_cursor, id, device_id, local_event_id, type, patient_id, local_timestamp, server_timestamp, payload_json")
    .eq("incident_id", incident_id)
    .gt("sync_cursor", Number.isFinite(since_cursor) ? since_cursor : 0)
    .order("sync_cursor", { ascending: true })
    .limit(limit);

  if (error) {
    logEvent("pull_query_failed", { caller_id: callerId, incident_id, message: error.message });
    return json({ error: "query_failed", message: error.message }, 400);
  }

  const events = (data ?? []).map((e: Record<string, unknown>) => ({
    server_cursor: e.sync_cursor,
    server_event_id: e.id,
    device_id: e.device_id,
    local_event_id: e.local_event_id,
    type: e.type,
    patient_id: e.patient_id,
    local_timestamp: e.local_timestamp,
    server_timestamp: e.server_timestamp,
    payload_json: e.payload_json,
  }));

  const next_cursor = events.length > 0 ? events[events.length - 1].server_cursor : since_cursor;
  const has_more = events.length === limit;

  logEvent("pull_batch_completed", { caller_id: callerId, incident_id, since_cursor, returned: events.length, has_more });

  return json({
    server_time: new Date().toISOString(),
    next_cursor,
    events,
    has_more,
  });
}
