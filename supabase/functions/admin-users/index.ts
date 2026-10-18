// C5 Sentinel-SAR admin user invitations - the in-app replacement for scripts/invite_user.js.
//
// Design notes:
// - Only an active admin may call this (checked here from the caller's own JWT + profiles row,
//   the same way sync-log checks its caller). The admin picks the role per invitation; the
//   invitee never chooses one. The role goes into the invite's user_metadata, where
//   handle_new_user() (database/011/017) reads it to create an active profile.
// - The service-role key never leaves the server: this function is the only place in the app
//   that uses it for user management.
// - Two delivery modes:
//   * "link" (default): auth.admin.generateLink() creates the account and returns a one-time
//     token WITHOUT sending any email. The admin shares the link through any channel. This
//     works even when the project's built-in email service refuses non-team addresses
//     ("Email address not authorized") or hits its hourly limit.
//     The link points at the app itself (?token_hash=...&type=invite|recovery), not at
//     /auth/v1/verify. A messaging app that opens links to build a preview therefore cannot
//     consume the token: it is only spent when the app's own code calls verifyOtp()
//     (index.html captureAuthLinkSignal()/restoreSession(), docs/AUTH_INVITE_AND_PASSWORD_RESET.md).
//   * "email": Supabase sends its own invite / password-reset email.
// - Resend: an account that never confirmed gets a fresh invite; an account that already
//   confirmed (including one that opened the link but never set a password) gets a
//   password-reset link, which goes through the same set-password screen.
// - Every successful invite / resend is written to admin_user_audit (database/042). Role and
//   is_active changes are audited there by trigger, not by this function.
// - Logs carry ids and outcomes only - never the link, the token, or an email address.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Where invited users open the app (GitHub Pages). Overridable without a code change.
const APP_URL = Deno.env.get("APP_URL") ?? "https://raanank10.github.io/Medical-C5-System-For-SAR/";

// Must match the live user_role enum (scripts/invite_user.js keeps the same list).
const VALID_ROLES = ["medic", "paramedic", "physician", "pc", "cc", "chamal", "logistics_officer", "rpc", "rcc", "admin"];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function logEvent(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, fn: "admin-users", ...fields }));
}

function appLink(hashedToken: string, type: "invite" | "recovery"): string {
  const url = new URL(APP_URL);
  url.searchParams.set("token_hash", hashedToken);
  url.searchParams.set("type", type);
  return url.toString();
}

// Maps an Auth error to a stable code the client can show in Hebrew.
// deno-lint-ignore no-explicit-any
function authErrorCode(err: any): string {
  const code = String(err?.code || "");
  const msg = String(err?.message || "").toLowerCase();
  if (code === "email_exists" || code === "user_already_exists" || msg.includes("already been registered")) return "already_registered";
  if (code === "email_address_not_authorized" || msg.includes("not authorized")) return "email_not_authorized";
  if (code.startsWith("over_") || msg.includes("rate limit")) return "rate_limited";
  if (code === "email_address_invalid" || msg.includes("invalid")) return "invalid_email";
  return "auth_error";
}

type Client = SupabaseClient;

async function writeAudit(serviceClient: Client, row: Record<string, unknown>): Promise<boolean> {
  const { error } = await serviceClient.from("admin_user_audit").insert(row);
  if (error) {
    logEvent("audit_insert_failed", { message: error.message, target_user_id: row.target_user_id });
    return false;
  }
  return true;
}

async function handleInvite(body: Record<string, unknown>, serviceClient: Client, callerId: string): Promise<Response> {
  const email = String(body.email || "").trim().toLowerCase();
  const role = String(body.role || "");
  const displayName = String(body.display_name || "").trim().slice(0, 80) || null;
  const delivery = body.delivery === "email" ? "email" : "link";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);
  if (!VALID_ROLES.includes(role)) return json({ error: "invalid_role" }, 400);

  const data: Record<string, string> = { role };
  if (displayName) data.display_name = displayName;

  let userId: string | null = null;
  let link: string | null = null;
  if (delivery === "link") {
    const { data: gen, error } = await serviceClient.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data, redirectTo: APP_URL },
    });
    if (error || !gen?.properties?.hashed_token) {
      const code = error ? authErrorCode(error) : "auth_error";
      logEvent("invite_failed", { caller_id: callerId, delivery, code });
      return json({ error: code }, code === "already_registered" ? 409 : 422);
    }
    userId = gen.user?.id ?? null;
    link = appLink(gen.properties.hashed_token, "invite");
  } else {
    const { data: inv, error } = await serviceClient.auth.admin.inviteUserByEmail(email, { data, redirectTo: APP_URL });
    if (error) {
      const code = authErrorCode(error);
      logEvent("invite_failed", { caller_id: callerId, delivery, code });
      return json({ error: code }, code === "already_registered" ? 409 : code === "rate_limited" ? 429 : 422);
    }
    userId = inv?.user?.id ?? null;
  }

  // An address that was already invited but never accepted is not an error for Auth: it just
  // issues a new token for the EXISTING account, whose profile (and role) was created on the
  // first invite. Refuse to report that as a new invite with the requested role.
  if (userId) {
    const { data: profile } = await serviceClient.from("profiles").select("role, is_active").eq("id", userId).maybeSingle();
    if (profile && profile.role !== role) {
      logEvent("invite_existing_different_role", { caller_id: callerId, target_user_id: userId });
      return json({ error: "already_invited_different_role", existing_role: profile.role, user_id: userId }, 409);
    }
  }

  const auditLogged = await writeAudit(serviceClient, {
    actor_id: callerId,
    actor_role: "admin",
    target_user_id: userId,
    target_email: email,
    action: "invited",
    new_role: role,
    details: { delivery },
  });
  logEvent("invited", { caller_id: callerId, target_user_id: userId, delivery, role });
  return json({ ok: true, user_id: userId, delivery, link, link_type: "invite", audit_logged: auditLogged });
}

async function handleResend(body: Record<string, unknown>, serviceClient: Client, callerId: string): Promise<Response> {
  const userId = String(body.user_id || "");
  const delivery = body.delivery === "email" ? "email" : "link";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: "invalid_user_id" }, 400);

  const { data: got, error: getErr } = await serviceClient.auth.admin.getUserById(userId);
  const user = got?.user;
  if (getErr || !user?.email) return json({ error: "user_not_found" }, 404);

  const { data: profile } = await serviceClient.from("profiles").select("role, is_active").eq("id", userId).maybeSingle();
  if (!profile) return json({ error: "no_profile" }, 409);
  // A link for a locked-out account would only lead to "no active profile" after the password
  // is set. Reactivate first (that change is itself audited).
  if (!profile.is_active) return json({ error: "user_deactivated" }, 409);

  const linkType: "invite" | "recovery" = user.email_confirmed_at ? "recovery" : "invite";
  let link: string | null = null;
  if (delivery === "link") {
    const { data: gen, error } = await serviceClient.auth.admin.generateLink({
      type: linkType,
      email: user.email,
      options: { redirectTo: APP_URL },
    });
    if (error || !gen?.properties?.hashed_token) {
      const code = error ? authErrorCode(error) : "auth_error";
      logEvent("resend_failed", { caller_id: callerId, target_user_id: userId, delivery, code });
      return json({ error: code }, 422);
    }
    link = appLink(gen.properties.hashed_token, linkType);
  } else {
    const { error } = linkType === "invite"
      ? await serviceClient.auth.admin.inviteUserByEmail(user.email, { redirectTo: APP_URL })
      : await serviceClient.auth.resetPasswordForEmail(user.email, { redirectTo: APP_URL });
    if (error) {
      const code = authErrorCode(error);
      logEvent("resend_failed", { caller_id: callerId, target_user_id: userId, delivery, code });
      return json({ error: code }, code === "rate_limited" ? 429 : 422);
    }
  }

  const auditLogged = await writeAudit(serviceClient, {
    actor_id: callerId,
    actor_role: "admin",
    target_user_id: userId,
    target_email: user.email,
    action: "reinvited",
    new_role: profile.role,
    details: { delivery, link_type: linkType },
  });
  logEvent("reinvited", { caller_id: callerId, target_user_id: userId, delivery, link_type: linkType });
  return json({ ok: true, user_id: userId, delivery, link, link_type: linkType, audit_logged: auditLogged });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "missing_authorization" }, 401);
    }

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
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
    if (profileErr || !profile || !profile.is_active || profile.role !== "admin") {
      logEvent("not_admin", { caller_id: callerId });
      return json({ error: "admin_only" }, 403);
    }

    // deno-lint-ignore no-explicit-any
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    if (body?.action === "invite") return await handleInvite(body, serviceClient, callerId);
    if (body?.action === "resend") return await handleResend(body, serviceClient, callerId);
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    logEvent("unhandled_exception", { message: e instanceof Error ? e.message : String(e) });
    return json({ error: "internal_error" }, 500);
  }
});
