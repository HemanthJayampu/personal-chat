// Admin actions that need the service role: delete / reject a user and
// reset a password (FR-9, 7.7). Approve / disable / enable go straight
// through RLS from the app, because they're plain profile updates.
import { callerClient, json, preflight, serviceClient, serve } from "../_shared/http.ts";

const BUCKET = "chat-files";

serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  // Only an approved admin on a 2FA-verified (aal2) session gets past here.
  const caller = callerClient(req);
  const { data: isAdmin, error: adminErr } = await caller.rpc("is_admin");
  if (adminErr || isAdmin !== true) {
    return json({ error: "Admin access with two-factor authentication is required." }, 403);
  }
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user: me } } = await caller.auth.getUser(token);
  if (!me) return json({ error: "Not signed in." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = String(body.action ?? "");
  const userId = String(body.user_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(userId)) return json({ error: "Missing user." }, 400);
  if (userId === me.id) return json({ error: "You can't do that to your own account." }, 400);

  const admin = serviceClient();
  const { data: target } = await admin.from("profiles").select("id, username, role")
    .eq("id", userId).maybeSingle();
  if (!target) return json({ error: "User not found." }, 404);

  const audit = (act: string, details: Record<string, unknown> = {}) =>
    admin.from("audit_log").insert({
      actor_id: me.id, action: act, target_id: userId,
      details: { username: target.username, ...details },
    });

  if (action === "delete" || action === "reject") {
    // Their "My Devices" space (and any chat where they're the only member
    // left) would be orphaned: remove its files through the Storage API,
    // then the conversation.
    const { data: mine } = await admin.from("conversation_members")
      .select("conversation_id").eq("user_id", userId);
    const orphanIds: string[] = [];
    for (const row of mine ?? []) {
      const { count } = await admin.from("conversation_members")
        .select("user_id", { count: "exact", head: true })
        .eq("conversation_id", row.conversation_id);
      if ((count ?? 0) <= 1) orphanIds.push(row.conversation_id);
    }
    if (orphanIds.length) {
      const { data: files } = await admin.from("files").select("storage_path")
        .in("conversation_id", orphanIds);
      const paths = (files ?? []).map((f) => f.storage_path);
      for (let i = 0; i < paths.length; i += 100) {
        await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      }
      await admin.from("conversations").delete().in("id", orphanIds);
    }

    await audit(action === "reject" ? "user_rejected" : "user_deleted");
    const { error } = await admin.auth.admin.deleteUser(userId);   // cascades to profile
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "reset_password") {
    const temp = tempPassword();
    const { error } = await admin.auth.admin.updateUserById(userId, { password: temp });
    if (error) return json({ error: error.message }, 500);
    await admin.from("profiles").update({ must_change_password: true }).eq("id", userId);
    await audit("password_reset");
    // Shown once to the admin, never stored or logged.
    return json({ ok: true, temp_password: temp });
  }

  return json({ error: "Unknown action." }, 400);
});

// 14 chars, unambiguous alphabet, always has letters and digits.
function tempPassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits;
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < 14) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
