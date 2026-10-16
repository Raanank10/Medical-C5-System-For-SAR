# Auth: Invite Acceptance and Password Reset

## The gap this closes

An admin invites someone via `scripts/invite_user.js` (calls Supabase's Auth Admin `/auth/v1/invite` endpoint with `role` baked into the invite's metadata, since the Supabase dashboard's own "Send invitation" button has no field for that). Supabase's **default** invite email template links to GoTrue's own `/auth/v1/verify` endpoint, which establishes a session server-side and redirects the browser to the project's Site URL with `#access_token=...&refresh_token=...&type=invite&...` in the URL hash.

`getSupabaseClient()` (`index.html`) uses supabase-js's default `detectSessionInUrl: true`, so the client silently auto-establishes a real, persisted session from that hash on page load — before any app code runs. Since `handle_new_user()` (`database/011_handle_new_user_reads_role_from_metadata.sql`) already creates a correctly-configured `profiles` row (role + `is_active`) synchronously when the `auth.users` row is created, `restoreSession()` would previously find that session, find a valid active profile, and route the person straight into their real role dashboard.

**No password was ever set.** Their only way back in was clicking another invite/magic link, permanently. This matches a documented Supabase footgun (supabase/supabase#45210: "invite and recovery links create a persistent authenticated session before password is set").

## How the fix works

1. **`captureAuthLinkSignal()`** (near the top of `index.html`'s main script, runs before `getSupabaseClient()` is ever called) synchronously inspects `location.hash` and `location.search` for the invite/recovery signal, before supabase-js gets a chance to consume and clear the hash. Stored in the module-level `AUTH_LINK_SIGNAL` constant. Handles three cases:
   - `mode:'implicit'` — the default template's shape: `#access_token=...&type=invite|recovery`. A session already exists by the time our code checks.
   - `mode:'pkce'`: `?token_hash=...&type=invite|recovery`. No session yet; the app must call `client.auth.verifyOtp({token_hash, type})` itself. In use since V2.99.30: the in-app invite links (below) have this shape. The token is removed from the address bar right after the app has tried it (`clearAuthLinkFromUrl()`), so a later reload, bookmark or screenshot never carries a spent token; it is kept until then, so a reload while a new device is still at the PIN screen does not lose the link.
   - `mode:'error'` — GoTrue redirected with `#error=...&error_code=otp_expired` etc. (expired or already-used link, no session ever created).

2. **`restoreSession()`** checks `AUTH_LINK_SIGNAL` before its normal `loadProfileAndEnter()` dashboard-entry path: on `'error'` or a failed `verifyOtp`, shows the expired-link panel; on `'implicit'` or a successful `'pkce'` exchange, routes to `screen-set-password` via `enterSetPasswordFlow()` instead of entering the app.

3. **`screen-set-password`** — new/confirm password fields, calls `client.auth.updateUser({password})`. On success, calls the *real* `loadProfileAndEnter()` (same function `signIn()` uses) to actually enter the app — so setting a password and a normal login converge on identical code from that point on.

4. **Secondary safety net**: `getSupabaseClient()` also listens for the `PASSWORD_RECOVERY` `onAuthStateChange` event and routes to the same set-password flow if it fires — this is *not* the primary detector (it's documented as unreliable — ordering issues, doesn't always fire), just defense in depth.

5. **Forgot password**: `screen-login` has a "שכחתי סיסמה" button calling `requestPasswordReset()` → `client.auth.resetPasswordForEmail(email)`. The resulting recovery email link is handled by the exact same machinery above (`type=recovery` instead of `type=invite`, differing only in the screen's title text).

## In-app invitations (V2.99.30)

An active admin invites people from the "ניהול משתמשים" screen (`supabase/functions/admin-users/index.ts`, `database/042_admin_user_management.sql`; roles and audit in `docs/AUTH_AND_ROLE_MODEL.md`'s Account Lifecycle). Two delivery modes:

- **One-time link (default).** `auth.admin.generateLink()` creates the account (with the chosen role in its metadata) and returns a token **without sending any email**. The admin copies or shares the link through any channel. The link points at the app itself, `https://raanank10.github.io/Medical-C5-System-For-SAR/?token_hash=...&type=invite`, not at `/auth/v1/verify`, for two reasons:
  - A messaging app (WhatsApp, Telegram, Slack) opens a pasted link to build a preview. A `/auth/v1/verify` link would be spent by that preview before the person ever taps it. The app link is only spent when the app's own code runs `verifyOtp()`, which a preview fetch never does.
  - It does not depend on the Site URL / Redirect URL settings below.
  Whoever holds the link can set the account's password, so the admin should send it only to that person. It expires after the project's email OTP expiry; the user list offers a fresh one.
- **Supabase email.** Supabase sends its own invite email. **Without a custom SMTP server, Supabase's built-in email service only delivers to members of the Supabase organization's team** and refuses every other address ("Email address not authorized"); it also has a low hourly limit. The app shows that error in Hebrew and suggests the link mode. The email's link goes through `/auth/v1/verify` and then redirects to the Site URL, so it is handled by the `mode:'implicit'` path above.

**Resend** from the user list: a user who never confirmed gets a new invite token; a confirmed user (including one who opened a link but never set a password) gets a password-reset token. Both land on `screen-set-password`. Each new token replaces the previous one.

**Dashboard settings to check** (Supabase dashboard, Authentication):
- URL Configuration > Site URL: `https://raanank10.github.io/Medical-C5-System-For-SAR/` (needed by the email mode and by "שכחתי סיסמה").
- URL Configuration > Redirect URLs: add the same URL, so the `redirectTo` the function passes is accepted.
- Emails > SMTP Settings: only if email delivery to non-team addresses is wanted.

The "שכחתי סיסמה" button on the login screen sends a Supabase email too, so the same team-only restriction applies to it until custom SMTP is configured. An admin can always issue a password-reset link from the user list instead.

## Password policy

Minimum 6 characters, checked client-side before the network call — matches Supabase Auth's own server-side default minimum. No additional strength policy is enforced. If this deployment's needs change, update both the client-side check in `attemptSetPassword()` and Supabase's dashboard password-policy setting together.

## Related files

- `supabase/functions/admin-users/index.ts`: the in-app invite / resend endpoint (admin only).
- `database/042_admin_user_management.sql`: user list, role change, (de)activation RPCs and the `admin_user_audit` trail.
- `scripts/invite_user.js`: fallback CLI that sends invites with role metadata via the Admin API.
- `database/011_handle_new_user_reads_role_from_metadata.sql` — the trigger that creates the `profiles` row on `auth.users` insert, reading role from invite metadata.
- Supabase dashboard → Authentication → URL Configuration → Site URL must point at the real deployed app (not left at the `localhost:3000` default) for any of this to be reachable at all.
