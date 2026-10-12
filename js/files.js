// 5.4 / 7.5: uploads with progress, signed-URL downloads.
import { sb } from "./supabase.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SIGNED_URL_SECONDS, MAX_FILE_BYTES } from "../config.js";
import { safeName, fmtSize } from "./ui.js";

export const BUCKET = "chat-files";

// FR-20: checked before any bytes leave the device. The bucket enforces
// the same limit server-side.
export function sizeProblem(file) {
  return file.size > MAX_FILE_BYTES
    ? `"${file.name}" is ${fmtSize(file.size)}. The limit is ${fmtSize(MAX_FILE_BYTES)}.`
    : null;
}

// Path format {conversation_id}/{uuid}_{filename}; the storage policy checks
// the first folder against conversation membership.
export async function uploadFile(convId, userId, file, onProgress) {
  const tooBig = sizeProblem(file);
  if (tooBig) throw new Error(tooBig);

  const path = `${convId}/${crypto.randomUUID()}_${safeName(file.name)}`;
  await putObject(path, file, onProgress);

  const { data, error } = await sb.from("files").insert({
    conversation_id: convId,
    uploader_id: userId,
    storage_path: path,
    file_name: (file.name || "file").slice(-255),
    mime_type: file.type || null,
    size_bytes: file.size,
  }).select().single();

  if (error) {
    await sb.storage.from(BUCKET).remove([path]);   // don't orphan the object
    throw error;
  }
  return data;
}

// supabase-js upload() has no progress events, so this talks to the Storage
// REST endpoint directly with XHR (FR-21). Same auth, same RLS.
async function putObject(path, file, onProgress) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("You're signed out.");

  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/` +
              path.split("/").map(encodeURIComponent).join("/");

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
    xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Upload failed (${xhr.status}).`;
      try {
        const j = JSON.parse(xhr.responseText);
        msg = j.message || j.error || msg;
      } catch { /* not JSON */ }
      if (xhr.status === 413 || /too large|exceeded/i.test(msg)) msg = "The file is larger than the 50 MB limit.";
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading."));
    xhr.send(file);
  });
}

// FR-22: valid for 1 hour, so a forwarded link stops working.
export async function signedUrl(path, downloadName) {
  const { data, error } = await sb.storage.from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS, downloadName ? { download: downloadName } : undefined);
  if (error) { console.error(error); return null; }
  return data.signedUrl;
}

// Storage object first, then the metadata row (which writes the audit entry).
export async function deleteFile(file) {
  const { error } = await sb.storage.from(BUCKET).remove([file.storage_path]);
  if (error) throw error;
  await sb.from("files").delete().eq("id", file.id);
}

export async function download(file) {
  const url = await signedUrl(file.storage_path, file.file_name);
  if (!url) throw new Error("This file is no longer available.");
  // The signed URL answers with Content-Disposition: attachment, so this
  // downloads without navigating away. It also survives popup blockers,
  // which a window.open() after an await does not.
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
