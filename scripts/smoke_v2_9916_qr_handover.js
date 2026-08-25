const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', path.join('demo', 'rescue-app.html')];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function section(html, startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert(start >= 0, `missing section start: ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing section end: ${endNeedle}`);
  return html.slice(start, end);
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const tokenFn = section(html, 'async function generateHandoverToken(){', 'async function generateQrHandover(id){');
  const qrFn = section(html, 'async function generateQrHandover(id){', 'function copyHandoverQrLink(){');

  assert(html.includes("const APP_VERSION = '2.99.16';"), `${rel}: APP_VERSION must be V2.9916`);
  assert(html.includes('Demo V2.9916'), `${rel}: launcher label must be Demo V2.9916`);
  assert(html.includes('ROLE // V2.9916'), `${rel}: role header must be Demo V2.9916`);
  assert(html.includes('Role-Based Medical Command System V2.9916'), `${rel}: role system strip must be Demo V2.9916`);

  // Token is generated entirely client-side/offline - no live "issue" network call - and only
  // the hash (never the raw secret) rides through the normal offline-first sync pipeline.
  assert(tokenFn.includes("crypto.getRandomValues(new Uint8Array(24))"), `${rel}: handover secret must be a real random value, not derived from patient/predictable data`);
  assert(tokenFn.includes("crypto.subtle.digest('SHA-256', secretBytes)"), `${rel}: token_hash must be a real SHA-256 digest of the secret`);
  assert(tokenFn.includes("SUPABASE_ANON_KEY"), `${rel}: token_signature must use the existing public anon key as HMAC material, not a new invented secret`);
  assert(html.includes('id="handover-qr-modal"'), `${rel}: handover QR modal missing`);

  assert(qrFn.includes("handover_method:'secure_qr_token'"), `${rel}: generateQrHandover must write the secure_qr_token handover method`);
  assert(qrFn.includes('token_hash:tokenHash') && qrFn.includes('token_signature:tokenSignature') && qrFn.includes('token_expires_at:expiresAt'), `${rel}: generateQrHandover must include token fields in the PATIENT_HANDED_OVER payload`);
  assert(qrFn.includes('saveLocalEvent({...event, patient_id:p.id});'), `${rel}: generateQrHandover must go through the same offline-first saveLocalEvent path as the plain handover`);
  assert(qrFn.includes('/functions/v1/handover-consume?h=') && qrFn.includes('&s='), `${rel}: generated link must point at the real deployed handover-consume function with hash+secret params`);

  // Deliberate scope cut: link only, no scannable QR image rendered (no new dependency) -
  // must not silently claim to draw one.
  assert(!html.toLowerCase().includes('qrcode'), `${rel}: no QR-image library/dependency should be referenced`);

  console.log(`${rel}: Demo V2.9916 secure QR handover static smoke passed`);
}
