#!/usr/bin/env node
// Section 13: automated part of the security test checklist.
// Talks to the live project with plain fetch (Node 18+, no npm install).
//
//   node scripts/security-check.mjs
//
// Optional, for the signed-in checks -- create throwaway test accounts:
//   PENDING_USER / PENDING_PASS   a user who signed up but is NOT approved
//   MEMBER_USER  / MEMBER_PASS    an approved member WITHOUT 2FA, not admin
//
// Checks that need a human (signed URL expiry after 1 hour, rate limiting
// on repeated wrong passwords, a 50 MB upload) are listed at the end.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const cfg = readFileSync(join(root, "config.js"), "utf8");
const pick = (name) => cfg.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`))?.[1];
const URL_ = pick("SUPABASE_URL");
const KEY = pick("SUPABASE_ANON_KEY");
const DOMAIN = pick("USERNAME_EMAIL_DOMAIN") || "mychat.local";
if (!URL_ || !KEY) { console.error("Couldn't read SUPABASE_URL / SUPABASE_ANON_KEY from config.js"); process.exit(2); }

let failed = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failed++; console.log(`  ✗ ${msg}`); };
const check = (ok, msg) => (ok ? pass(msg) : fail(msg));

async function api(path, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(URL_ + path, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${token || KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

const rows = (r) => (Array.isArray(r.data) ? r.data.length : 0);
const TABLES = ["profiles", "conversations", "conversation_members", "messages", "files", "invite_codes", "audit_log", "legacy_messages"];

async function signIn(user, pass) {
  const r = await api("/auth/v1/token?grant_type=password", {
    method: "POST", body: { email: `${user}@${DOMAIN}`, password: pass },
  });
  if (!r.data?.access_token) throw new Error(`could not sign in as ${user}: ${r.data?.msg || r.data?.error_description || r.status}`);
  return { token: r.data.access_token, id: r.data.user.id };
}

console.log("\nSign-up");
{
  const r = await api("/auth/v1/signup", { method: "POST", body: { email: `probe${Date.now()}@${DOMAIN}`, password: "probe-password-123" } });
  check(r.status >= 400, `public sign-up through Supabase Auth is disabled (HTTP ${r.status})`);

  const none = await api("/functions/v1/signup-with-invite", { method: "POST", body: { username: "probe_user", password: "probepass123" } });
  check(none.status >= 400, `sign-up without an invite code fails (HTTP ${none.status}: ${none.data?.error ?? ""})`);

  const bad = await api("/functions/v1/signup-with-invite", { method: "POST", body: { username: "probe_user", password: "probepass123", invite_code: "not-a-real-code" } });
  check(bad.status >= 400, `sign-up with a bad invite code fails (HTTP ${bad.status}: ${bad.data?.error ?? ""})`);
}

console.log("\nAnonymous access (anon key, not signed in)");
for (const t of TABLES) {
  const r = await api(`/rest/v1/${t}?select=*&limit=5`);
  check(rows(r) === 0, `${t}: ${rows(r) === 0 ? `no rows (HTTP ${r.status})` : `${rows(r)} ROWS VISIBLE`}`);
}
{
  const r = await api("/rest/v1/rpc/ping", { method: "POST", body: {} });
  check(r.status === 200, "ping() keep-alive endpoint answers");
  const s = await api("/storage/v1/object/list/chat-files", { method: "POST", body: { prefix: "", limit: 5 } });
  check(rows(s) === 0, `storage bucket listing returns nothing (HTTP ${s.status})`);
}

if (process.env.PENDING_USER) {
  console.log("\nPending user");
  try {
    const { token, id } = await signIn(process.env.PENDING_USER, process.env.PENDING_PASS);
    for (const t of TABLES.filter((x) => x !== "profiles")) {
      const r = await api(`/rest/v1/${t}?select=*&limit=5`, { token });
      check(rows(r) === 0, `${t}: ${rows(r) === 0 ? "no rows" : `${rows(r)} ROWS VISIBLE`}`);
    }
    const p = await api("/rest/v1/profiles?select=id", { token });
    check(rows(p) <= 1 && (rows(p) === 0 || p.data[0].id === id), "profiles: only their own row");
    const up = await api(`/rest/v1/profiles?id=eq.${id}`, { method: "PATCH", token, body: { status: "approved" }, headers: { Prefer: "return=representation" } });
    check(up.status >= 400 || rows(up) === 0, `cannot approve themselves (HTTP ${up.status})`);
  } catch (e) { fail(e.message); }
}

if (process.env.MEMBER_USER) {
  console.log("\nApproved member");
  try {
    const { token, id } = await signIn(process.env.MEMBER_USER, process.env.MEMBER_PASS);
    const role = await api(`/rest/v1/profiles?id=eq.${id}`, { method: "PATCH", token, body: { role: "admin" }, headers: { Prefer: "return=representation" } });
    check(role.status >= 400, `cannot make themselves admin (HTTP ${role.status}: ${role.data?.message ?? ""})`);

    const fake = "00000000-0000-4000-8000-000000000000";
    const read = await api(`/rest/v1/messages?conversation_id=eq.${fake}&select=*`, { token });
    check(rows(read) === 0, "cannot read a conversation they are not in");
    const write = await api("/rest/v1/messages", { method: "POST", token, body: { conversation_id: fake, sender_id: id, content: "probe" } });
    check(write.status >= 400, `cannot post into a conversation they are not in (HTTP ${write.status})`);
    const spoof = await api("/rest/v1/messages", { method: "POST", token, body: { conversation_id: fake, sender_id: fake, content: "probe" } });
    check(spoof.status >= 400, `cannot send as someone else (HTTP ${spoof.status})`);

    for (const t of ["invite_codes", "audit_log"]) {
      const r = await api(`/rest/v1/${t}?select=*&limit=5`, { token });
      check(rows(r) === 0, `${t}: admin only`);
    }
    const inv = await api("/rest/v1/invite_codes", { method: "POST", token, body: { code: "probe-" + Date.now(), expires_at: new Date(Date.now() + 864e5).toISOString() } });
    check(inv.status >= 400, `cannot create invite codes (HTTP ${inv.status})`);
    const adm = await api("/functions/v1/admin-users", { method: "POST", token, body: { action: "reset_password", user_id: id } });
    check(adm.status === 403 || adm.status === 400, `admin function refuses a member (HTTP ${adm.status})`);
  } catch (e) { fail(e.message); }
}

console.log("\nFrontend files");
{
  // Exactly what the Pages workflow publishes.
  const list = (d) => readdirSync(join(root, d)).map((f) => join(root, d, f))
    .filter((p) => statSync(p).isFile() && /\.(js|html|css|json|svg)$/.test(p));
  const files = [...list("."), ...list("js"), ...list("icons")].filter((p) => !p.endsWith(".mjs"));
  const leaks = files.filter((f) => /service_role|sb_secret_/.test(readFileSync(f, "utf8")));
  check(leaks.length === 0, leaks.length ? `secret key reference in: ${leaks.join(", ")}` : "no service_role / sb_secret_ key in frontend files");
}

console.log(`
Check by hand (section 13):
  - Copy a file's link from the app, wait over an hour, open it: it must fail.
  - Try to attach a file over 50 MB: the app must refuse before uploading.
  - Sign in with a wrong password ~10 times quickly: Supabase must rate-limit.
  - Disable a signed-in test user from Admin: their app must lock at once.
  - Sign in as admin without the 2FA code step: Admin must show nothing.
  - git log -p | grep -E 'sb_secret_[A-Za-z0-9]{8,}|eyJhbGci[O]i'  must print nothing (real keys, not mentions).
`);
console.log(failed ? `${failed} check(s) FAILED` : "All automated checks passed.");
process.exit(failed ? 1 : 0);
