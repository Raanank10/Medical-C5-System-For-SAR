// C5 Sentinel-SAR secure QR handover consume endpoint - docs/API_SURFACE_v1.2.md's
// "Medical Handover Event (MIST / ATMIST)" secure_qr_token path.
//
// Design notes:
// - Anon-callable by design (verify_jwt=false at deploy time): a receiving unit (MDA crew,
//   another platform) has no Supabase account and must be able to open this link from any
//   device, including a plain browser tapping a scanned QR code - custom authentication is
//   the token itself (a random secret only the sending device ever held), not a JWT.
// - The token issuer is the CLIENT (index.html's generateHandoverToken()), not this function -
//   there is no "issue" endpoint. The client generates a random secret fully offline, computes
//   its SHA-256 hash locally, and pushes the hash (never the secret) through the normal
//   offline-first sync-log push as part of an ordinary PATIENT_HANDED_OVER event.
//   project_patient_state() (database) inserts the patient_handover_tokens row when that event
//   lands. This means a freshly-generated link may not validate here until sync completes -
//   an honest offline-first failure mode, not a bug, and reported as such below.
// - token_hash is used as the lookup key (patient_handover_tokens.token_hash is UNIQUE), not an
//   opaque server-issued id, since the client can only know a value it computed itself before
//   any network round trip. It is not sensitive on its own (it's a hash); proof of possession
//   of the underlying secret is what this endpoint actually checks.
// - Runs entirely on the service-role client: patient_handover_tokens/patients/events are not
//   readable by anon/authenticated for this purpose (see docs/RLS_AUDIT_v1.md's follow-up
//   section - patient_handover_tokens has zero grants to anon/authenticated by design), so a
//   service-role client is the only way this function can do its job, matching the same
//   narrow, single-purpose use already established for sync-log's own service-role client.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function page(title: string, bodyHtml: string, tone: "ok" | "error" | "pending"): string {
  const accent = tone === "ok" ? "#34c759" : tone === "pending" ? "#ffcc00" : "#ff3b30";
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:'IBM Plex Sans Hebrew','Noto Sans Hebrew',Arial,sans-serif;background:#0a0a0f;color:#e8e8f0;margin:0;padding:24px 16px;direction:rtl}
.card{max-width:480px;margin:0 auto;background:#13131a;border:2px solid ${accent};border-radius:16px;padding:20px}
.h{font-size:18px;font-weight:800;color:${accent};margin-bottom:10px}
.row{margin:10px 0;font-size:14px;line-height:1.6}
.label{font-size:11px;color:#b4b4c8;text-transform:uppercase;letter-spacing:1px}
</style></head>
<body><div class="card"><div class="h">${escapeHtml(title)}</div>${bodyHtml}</div></body></html>`;
}

// Constant-time compare - the hash equality check below is between two server-computed hex
// strings (recomputed hash vs. the row looked up BY that same hash), so a timing side-channel
// here specifically would only leak information already implied by which row was found; kept
// for defense-in-depth rather than because a realistic attack was identified.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Structured logging (docs/OBSERVABILITY_REVIEW.md): outcome + non-sensitive ids only. Never
// log the secret (s), the token_hash, patient visual_id, or MIST clinical text - only the
// patient_id uuid (already used as a bare key throughout sync_ingestion_errors/watchdog_alerts/
// conflict_log in this schema, not treated as sensitive on its own in this system's model).
function logEvent(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, fn: "handover-consume", ...fields }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return html(page("שגיאה", `<div class="row">Method not allowed.</div>`, "error"), 405);
  }

  const url = new URL(req.url);
  const h = url.searchParams.get("h");
  const s = url.searchParams.get("s");
  if (!h || !s) {
    logEvent("missing_params", {});
    return html(page("קישור לא תקין", `<div class="row">חסרים פרמטרים בקישור.</div>`, "error"), 400);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // deno-lint-ignore no-explicit-any
  let tokenRow: any, tokenErr: any;
  try {
    ({ data: tokenRow, error: tokenErr } = await serviceClient
      .from("patient_handover_tokens")
      .select("id, patient_id, incident_id, source_event_id, destination_facility, receiving_unit_transport, token_hash, expires_at, consumed_at")
      .eq("token_hash", h)
      .maybeSingle());
  } catch (e) {
    logEvent("unhandled_exception", { message: e instanceof Error ? e.message : String(e) });
    return html(page("שגיאת מערכת", `<div class="row">אירעה שגיאה בלתי צפויה.</div>`, "error"), 500);
  }

  if (tokenErr) {
    logEvent("token_lookup_failed", { message: tokenErr.message });
    return html(page("שגיאת מערכת", `<div class="row">${escapeHtml(tokenErr.message)}</div>`, "error"), 500);
  }
  if (!tokenRow) {
    // Honest offline-first failure mode: the sending device may simply not have synced yet.
    logEvent("token_not_found", {});
    return html(
      page(
        "הקישור טרם פעיל",
        `<div class="row">קישור זה עדיין לא נקלט במערכת. ייתכן שהמכשיר השולח טרם התסנכרן. נסה שוב בעוד מספר דקות, או פנה לצוות השולח.</div>`,
        "pending",
      ),
      404,
    );
  }

  // Recompute the secret's hash and compare to the value the row was looked up by - proof of
  // possession of the secret, not just knowledge of its (non-sensitive) hash.
  const secretBytes = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const hashBuf = await crypto.subtle.digest("SHA-256", secretBytes);
  const recomputedHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!timingSafeEqual(recomputedHash, tokenRow.token_hash)) {
    logEvent("verification_failed", { token_id: tokenRow.id, patient_id: tokenRow.patient_id });
    return html(page("קישור לא תקין", `<div class="row">אימות נכשל.</div>`, "error"), 403);
  }

  if (tokenRow.consumed_at) {
    logEvent("already_consumed", { token_id: tokenRow.id, patient_id: tokenRow.patient_id });
    return html(
      page(
        "כבר נמסר",
        `<div class="row">מסירה זו כבר אושרה בתאריך ${escapeHtml(new Date(tokenRow.consumed_at).toLocaleString("he-IL"))}.</div>`,
        "pending",
      ),
      410,
    );
  }
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    logEvent("expired", { token_id: tokenRow.id, patient_id: tokenRow.patient_id });
    return html(
      page("הקישור פג תוקף", `<div class="row">בקש מהצוות השולח קישור חדש.</div>`, "error"),
      410,
    );
  }

  const [{ data: patient }, { data: sourceEvent }] = await Promise.all([
    serviceClient.from("patients").select("visual_id, current_triage").eq("id", tokenRow.patient_id).maybeSingle(),
    tokenRow.source_event_id
      ? serviceClient.from("events").select("payload_json").eq("id", tokenRow.source_event_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  await serviceClient
    .from("patient_handover_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", tokenRow.id)
    .is("consumed_at", null);

  const mist = (sourceEvent?.payload_json as Record<string, unknown> | undefined)?.mist_summary as
    | Record<string, string>
    | undefined;

  const bodyHtml = `
    <div class="row"><span class="label">פצוע</span><br>${escapeHtml(patient?.visual_id ?? tokenRow.patient_id)} · ${escapeHtml(patient?.current_triage ?? "—")}</div>
    <div class="row"><span class="label">יעד</span><br>${escapeHtml(tokenRow.destination_facility ?? "לא צוין")} · ${escapeHtml(tokenRow.receiving_unit_transport ?? "לא צוין")}</div>
    ${
    mist
      ? `<div class="row"><span class="label">MIST</span><br>
         מנגנון: ${escapeHtml(mist.mechanism ?? "—")}<br>
         פציעות: ${escapeHtml(mist.injuries ?? "—")}<br>
         סימנים: ${escapeHtml(mist.signs ?? "—")}<br>
         טיפול: ${escapeHtml(mist.treatment ?? "—")}</div>`
      : `<div class="row">אין סיכום MIST זמין.</div>`
  }
    <div class="row" style="color:#34c759;font-weight:800">✓ נמסר בהצלחה · ${new Date().toLocaleString("he-IL")}</div>
  `;

  logEvent("consumed", { token_id: tokenRow.id, patient_id: tokenRow.patient_id, incident_id: tokenRow.incident_id });

  return html(page("מסירת פצוע אושרה", bodyHtml, "ok"));
});
