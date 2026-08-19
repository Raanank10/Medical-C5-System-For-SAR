#!/usr/bin/env node
// Invite a real user with their correct role baked in from the start.
//
// The Supabase dashboard's "Send invitation" button has no field for role/metadata — inviting
// someone that way lands them with no working role (handle_new_user() now sets is_active=false
// when role metadata is missing/invalid, on purpose; see database/008_auto_create_profile_on_signup.sql
// and the fix applied 2026-08-19). This script goes around that gap: it calls the Auth Admin
// /invite endpoint directly, with the role in the invite's user_metadata, so handle_new_user()
// picks it up and the profile is created active with the right role in one step.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/invite_user.js <email> <role> [display_name]
//
// Example:
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/invite_user.js platoon.cmdr@example.com rpc "Amir Dagan"
//
// The service role key bypasses RLS entirely — never commit it, never pass it as a bare CLI arg
// (shell history), only ever via an environment variable for this one run.

const SUPABASE_URL = 'https://btvvjmuwdzirjyauyijx.supabase.co';

// Source of truth: the live `user_role` enum (database/006_add_rpc_rcc_enum_values.sql extended
// the original 001 schema's 6 values with rpc/rcc). Kept as a literal list here, matching how
// index.html's ROLE_LABELS and supabase/functions/sync-log/index.ts's ROLE_ALLOWED_EVENT_TYPES
// already hardcode the same role set rather than introspecting it at runtime.
const VALID_ROLES = ['medic', 'pc', 'cc', 'chamal', 'logistics_officer', 'rpc', 'rcc', 'admin'];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function main() {
  const [, , email, role, ...nameParts] = process.argv;
  const displayName = nameParts.join(' ').trim() || null;

  if (!email || !role) {
    fail(
      'missing arguments.\n\n' +
      'Usage: SUPABASE_SERVICE_ROLE_KEY=... node scripts/invite_user.js <email> <role> [display_name]\n' +
      `Valid roles: ${VALID_ROLES.join(', ')}`
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(`"${email}" doesn't look like a valid email address.`);
  }
  if (!VALID_ROLES.includes(role)) {
    fail(`"${role}" is not a valid role. Valid roles: ${VALID_ROLES.join(', ')}`);
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    fail(
      'SUPABASE_SERVICE_ROLE_KEY is not set.\n' +
      'Get it from the Supabase dashboard: Project Settings > API > service_role key.\n' +
      'Set it for this command only, e.g.:\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/invite_user.js ...'
    );
  }

  const data = { role };
  if (displayName) data.display_name = displayName;

  console.log(`Inviting ${email} as "${role}"${displayName ? ` (${displayName})` : ''}...`);

  let resp;
  try {
    resp = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ email, data }),
    });
  } catch (err) {
    fail(`network error calling Supabase: ${err.message}`);
  }

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    fail(`Supabase rejected the invite (${resp.status}): ${body.msg || body.error_description || JSON.stringify(body)}`);
  }

  console.log(`Invite sent to ${email}. They'll land with role="${role}" and an active profile as soon as they accept.`);
}

main();
