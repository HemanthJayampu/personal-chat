// FR-23 / section 10: delete expired files. Called daily by pg_cron.
// Objects go through the Storage API first, then the `files` rows (whose
// delete sets messages.file_id to null and writes a file_expired audit row).
//
// The caller must send the Vault secret "cleanup_secret" in x-cleanup-secret.
// It's generated inside Postgres (0002_cron.sql) and checked there too, so it
// never exists outside the database.
import { json, serviceClient, serve } from "../_shared/http.ts";

const BUCKET = "chat-files";
const BATCH = 100;

serve(async (req) => {
  const admin = serviceClient();

  const given = req.headers.get("x-cleanup-secret") ?? "";
  const { data: ok } = await admin.rpc("cleanup_secret_ok", { p_secret: given });
  if (ok !== true) return json({ error: "Unauthorized" }, 401);

  let removed = 0;

  for (let round = 0; round < 50; round++) {
    const { data: expired, error } = await admin.from("files")
      .select("id, storage_path")
      .lt("expires_at", new Date().toISOString())
      .limit(BATCH);
    if (error) return json({ error: error.message, removed }, 500);
    if (!expired?.length) break;

    const { error: rmErr } = await admin.storage.from(BUCKET)
      .remove(expired.map((f) => f.storage_path));
    if (rmErr) return json({ error: rmErr.message, removed }, 500);

    const { error: delErr } = await admin.from("files")
      .delete().in("id", expired.map((f) => f.id));
    if (delErr) return json({ error: delErr.message, removed }, 500);

    removed += expired.length;
  }

  return json({ ok: true, removed });
});
