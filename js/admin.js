// Screen 7: pending users, all users, invite codes, storage, audit log (5.2).
// Every query here is also gated by RLS on is_admin(), which needs a
// 2FA-verified session, so hiding the button is convenience, not security.
import { sb, callFunction } from "./supabase.js";
import { $, h, avatar, fmtSize, dateTimeLabel, copyText, toast, formError } from "./ui.js";
import { STORAGE_QUOTA_BYTES } from "../config.js";
import { currentUser } from "./chat.js";

const dlg = () => $("dlg-admin");
const err = (msg) => formError(dlg().querySelector(".dlg-body"), msg);
let tab = "pending";

const loaders = {
  pending: loadPending,
  users: loadUsers,
  invites: loadInvites,
  storage: loadStorage,
  audit: loadAudit,
};

export function initAdmin() {
  $("btn-admin").addEventListener("click", () => { dlg().showModal(); selectTab(tab); });
  dlg().querySelector("[data-close]").addEventListener("click", () => dlg().close());
  dlg().querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => selectTab(b.dataset.tab)));
  $("adm-invite-form").addEventListener("submit", createInvite);
}

function selectTab(name) {
  tab = name;
  err("");
  dlg().querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  dlg().querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  loaders[name]();
}

function fail(error) {
  console.error(error);
  err(/permission|row-level|42501/i.test(error.message)
    ? "Admin access needs a two-factor verified session. Sign out and back in with your code."
    : error.message);
}

// Dot on the sidebar shield + count on the tab.
export async function refreshPendingBadge() {
  const { count } = await sb.from("profiles").select("id", { count: "exact", head: true }).eq("status", "pending");
  const n = count || 0;
  $("btn-admin").classList.toggle("has-dot", n > 0);
  $("adm-pending-count").hidden = !n;
  $("adm-pending-count").textContent = n;
}

function userCell(p) {
  const name = p.display_name || p.username;
  return h("span", { className: "cell-user" }, avatar(name, 28),
    h("span", {}, h("strong", {}, name), " ", h("small", {}, "@" + p.username)));
}

const btn = (label, cls, onclick) => h("button", { type: "button", className: cls, onclick }, label);
const pill = (text, kind) => h("span", { className: "pill " + (kind || text) }, text);
const empty = (text) => h("li", { className: "empty" }, text);

// ---------------------------------------------------------------------------
// FR-8: pending users
// ---------------------------------------------------------------------------
async function loadPending() {
  const { data, error } = await sb.from("profiles").select("*").eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) return fail(error);
  refreshPendingBadge();
  $("adm-pending").replaceChildren(...(data.length ? data.map((p) =>
    h("li", { className: "row-item" },
      userCell(p),
      h("small", { className: "muted" }, "signed up " + dateTimeLabel(p.created_at)),
      h("span", { className: "actions" },
        btn("Approve", "primary", () => setStatus(p, "approved")),
        btn("Reject", "danger", () => removeUser(p, "reject")))))
    : [empty("No one is waiting for approval.")]));
}

// ---------------------------------------------------------------------------
// FR-9: all users
// ---------------------------------------------------------------------------
async function loadUsers() {
  const { data, error } = await sb.from("profiles").select("*").neq("status", "pending")
    .order("username", { ascending: true });
  if (error) return fail(error);
  const meId = currentUser()?.id;
  $("adm-users").replaceChildren(...data.map((p) => {
    const self = p.id === meId;
    const li = h("li", { className: "row-item" },
      userCell(p),
      h("span", { className: "pills" }, pill(p.role), pill(p.status),
        p.must_change_password ? pill("must change password", "warn") : null),
      h("span", { className: "actions" },
        self ? h("small", { className: "muted" }, "you") : [
          p.status === "approved"
            ? btn("Disable", "secondary", () => setStatus(p, "disabled"))
            : btn("Enable", "secondary", () => setStatus(p, "approved")),
          btn("Reset password", "secondary", () => resetPassword(p, li)),
          btn("Delete", "danger", () => removeUser(p, "delete")),
        ]));
    return li;
  }));
}

async function setStatus(p, status) {
  if (status === "disabled" && !confirm(`Disable @${p.username}? They lose access immediately.`)) return;
  const { error } = await sb.from("profiles").update({ status }).eq("id", p.id);
  if (error) return fail(error);
  toast(status === "approved" ? `@${p.username} can now use the app.` : `@${p.username} is disabled.`);
  loaders[tab]();
}

async function removeUser(p, action) {
  const q = action === "reject"
    ? `Reject @${p.username}? Their account will be deleted.`
    : `Delete @${p.username} permanently? Their My Devices space and its files are deleted too. Messages they sent to others stay, shown as "Deleted user".`;
  if (!confirm(q)) return;
  try {
    await callFunction("admin-users", { action, user_id: p.id });
  } catch (e) { return fail(e); }
  toast(action === "reject" ? `@${p.username} was rejected.` : `@${p.username} was deleted.`);
  loaders[tab]();
}

// 7.7: temporary password, shown once, user must change it on next login.
async function resetPassword(p, li) {
  if (!confirm(`Reset @${p.username}'s password? Their current password stops working.`)) return;
  let res;
  try { res = await callFunction("admin-users", { action: "reset_password", user_id: p.id }); }
  catch (e) { return fail(e); }

  li.querySelector(".temp-pass")?.remove();
  const copy = btn("copy", "linkish", async () => {
    copy.textContent = (await copyText(res.temp_password)) ? "copied" : "failed";
  });
  li.appendChild(h("div", { className: "temp-pass" },
    "Temporary password: ", h("code", {}, res.temp_password), copy,
    h("small", {}, "Share it privately. It's shown only once, and they'll have to choose a new one when they sign in.")));
}

// ---------------------------------------------------------------------------
// FR-10: invite codes
// ---------------------------------------------------------------------------
function newCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

async function createInvite(e) {
  e.preventDefault();
  const max_uses = Math.min(100, Math.max(1, parseInt($("adm-invite-uses").value, 10) || 1));
  const days = Math.min(365, Math.max(1, parseInt($("adm-invite-days").value, 10) || 7));
  const code = newCode();
  const { error } = await sb.from("invite_codes").insert({
    code, max_uses, created_by: currentUser().id,
    expires_at: new Date(Date.now() + days * 86400000).toISOString(),
  });
  if (error) return fail(error);
  const copied = await copyText(code);
  toast(copied ? `Invite ${code} created and copied.` : `Invite ${code} created.`, 4000);
  loadInvites();
}

async function loadInvites() {
  const { data, error } = await sb.from("invite_codes").select("*").order("created_at", { ascending: false });
  if (error) return fail(error);
  const now = Date.now();
  $("adm-invites").replaceChildren(...(data.length ? data.map((c) => {
    const expired = Date.parse(c.expires_at) <= now;
    const usedUp = c.used_count >= c.max_uses;
    const copy = btn("copy", "linkish", async () => {
      copy.textContent = (await copyText(c.code)) ? "copied" : "failed";
      setTimeout(() => (copy.textContent = "copy"), 1400);
    });
    return h("li", { className: "row-item" + (expired || usedUp ? " dim" : "") },
      h("code", { className: "code" }, c.code), copy,
      h("span", { className: "pills" },
        pill(`${c.used_count}/${c.max_uses} used`, usedUp ? "disabled" : "member"),
        pill(expired ? "expired" : "expires " + dateTimeLabel(c.expires_at), expired ? "disabled" : "approved")),
      h("span", { className: "actions" }, btn("Delete", "danger", async () => {
        if (!confirm(`Delete invite ${c.code}?`)) return;
        const { error: delErr } = await sb.from("invite_codes").delete().eq("code", c.code);
        if (delErr) return fail(delErr);
        loadInvites();
      })));
  }) : [empty("No invite codes yet.")]));
}

// ---------------------------------------------------------------------------
// FR-24: storage usage
// ---------------------------------------------------------------------------
async function loadStorage() {
  const { data, error } = await sb.rpc("storage_usage");
  if (error) return fail(error);
  const { bytes, file_count } = data[0] || { bytes: 0, file_count: 0 };
  const share = bytes / STORAGE_QUOTA_BYTES;
  $("adm-storage-text").textContent =
    `${fmtSize(bytes)} / ${fmtSize(STORAGE_QUOTA_BYTES)} used · ${file_count} file${file_count === 1 ? "" : "s"}`;
  $("adm-storage-bar").value = Math.min(1, share);
  $("adm-storage-bar").classList.toggle("high", share > 0.8);
}

// ---------------------------------------------------------------------------
// FR-11: audit log
// ---------------------------------------------------------------------------
const ACTION_LABELS = {
  signup: "signed up", login: "signed in", user_approved: "approved", user_rejected: "rejected",
  user_disabled: "disabled", user_enabled: "re-enabled", user_deleted: "deleted", role_changed: "changed role of",
  invite_created: "created invite", password_reset: "reset password of", password_changed: "changed their password",
  file_deleted: "deleted file", file_expired: "file expired",
};

async function loadAudit() {
  const { data, error } = await sb.from("audit_log").select("*, actor:profiles(username)")
    .order("created_at", { ascending: false }).limit(200);
  if (error) return fail(error);
  $("adm-audit").replaceChildren(...(data.length ? data.map((r) => {
    const d = r.details || {};
    const target = d.username && r.action !== "signup" ? "@" + d.username : d.file_name || d.code || "";
    return h("li", { className: "audit-row" },
      h("time", {}, dateTimeLabel(r.created_at)),
      h("span", {}, h("strong", {}, r.actor?.username ? "@" + r.actor.username : (r.action === "file_expired" ? "system" : "—")),
        " ", ACTION_LABELS[r.action] || r.action, target ? " " : "", target ? h("em", {}, target) : null));
  }) : [empty("Nothing logged yet.")]));
}
