// 7.2: the only way to create an account. Public sign-ups are switched off
// in Supabase Auth, so this function (holding the service role) is the gate.
import {
  clientIp, EMAIL_DOMAIN, json, passwordProblem, preflight, serve, serviceClient, USERNAME_RE,
} from "../_shared/http.ts";

const MAX_ATTEMPTS_PER_HOUR = 5;   // 7.8

serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  const admin = serviceClient();
  const ip = clientIp(req);

  // Every attempt counts, successful or not.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("signup_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip).gte("created_at", since);
  if ((count ?? 0) >= MAX_ATTEMPTS_PER_HOUR) {
    return json({ error: "Too many sign-up attempts. Try again in an hour." }, 429);
  }
  await admin.from("signup_attempts").insert({ ip });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const code     = String(body.invite_code ?? "").trim();

  if (!USERNAME_RE.test(username)) {
    return json({ error: "Username must be 3–20 characters: lowercase letters, numbers and _." }, 400);
  }
  const pwErr = passwordProblem(password);
  if (pwErr) return json({ error: pwErr }, 400);
  if (!code) return json({ error: "An invite code is required." }, 400);

  const { data: taken } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
  if (taken) return json({ error: "That username is taken." }, 409);

  // Atomic: checks expiry and remaining uses, and takes one use.
  const { data: ok, error: inviteErr } = await admin.rpc("consume_invite", { p_code: code });
  if (inviteErr) return json({ error: "Could not check the invite code." }, 500);
  if (!ok) return json({ error: "That invite code is invalid, expired or used up." }, 400);

  const { data: created, error } = await admin.auth.admin.createUser({
    email: `${username}@${EMAIL_DOMAIN}`,
    password,
    email_confirm: true,                 // the address can't receive mail
    user_metadata: { username },
  });
  if (error || !created?.user) {
    await admin.rpc("refund_invite", { p_code: code });
    const msg = /already|registered|exists/i.test(error?.message ?? "")
      ? "That username is taken."
      : (error?.message ?? "Could not create the account.");
    return json({ error: msg }, 400);
  }

  // The on_auth_user_created trigger makes the pending profile. If it
  // didn't (e.g. a username race), undo so no half-made account is left.
  const { data: profile } = await admin.from("profiles").select("id, status")
    .eq("id", created.user.id).maybeSingle();
  if (!profile) {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.rpc("refund_invite", { p_code: code });
    return json({ error: "That username is taken." }, 409);
  }

  await admin.from("audit_log").insert({
    actor_id: created.user.id,
    action: "signup",
    target_id: created.user.id,
    details: { username, invite_code: code, ip },
  });

  return json({ ok: true, status: profile.status });
});
