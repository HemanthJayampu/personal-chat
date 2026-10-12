// Screen 6: display name, change password, 2FA, notifications, sessions.
import { sb, passwordProblem } from "./supabase.js";
import { $, formError, busy, toast } from "./ui.js";
import { showEnroll } from "./auth.js";
import { signOut } from "./session.js";
import { currentUser, updateMe } from "./chat.js";
import { notificationState, requestNotifications } from "./notify.js";

const dlg = () => $("dlg-settings");
const err = (msg) => formError(dlg().querySelector(".dlg-body"), msg);

export function initSettings() {
  $("btn-settings").addEventListener("click", openSettings);
  dlg().querySelector("[data-close]").addEventListener("click", () => dlg().close());

  $("set-name-form").addEventListener("submit", saveName);
  $("set-pass-form").addEventListener("submit", changePassword);
  $("set-mfa-add").addEventListener("click", addMfa);
  $("set-mfa-remove").addEventListener("click", removeMfa);
  $("set-notif").addEventListener("click", async () => { await requestNotifications(); paintNotifications(); });
  $("set-logout").addEventListener("click", () => { dlg().close(); signOut(); });
  $("set-logout-all").addEventListener("click", () => {
    if (!confirm("Sign out on every device, including this one?")) return;
    dlg().close();
    signOut("Signed out of all devices.", "global");
  });
}

function openSettings() {
  const me = currentUser();
  if (!me) return;
  err("");
  $("set-display").value = me.display_name || "";
  $("set-username").textContent = `Signed in as @${me.username}${me.role === "admin" ? " (admin)" : ""}`;
  $("set-pass-form").reset();
  paintNotifications();
  paintMfa();
  dlg().showModal();
}

async function saveName(e) {
  e.preventDefault();
  const me = currentUser();
  const display_name = $("set-display").value.trim() || me.username;
  await busy(e.currentTarget, async () => {
    const { error } = await sb.from("profiles").update({ display_name }).eq("id", me.id);
    if (error) return err(error.message);
    err("");
    updateMe({ display_name });
    toast("Display name saved.");
  });
}

// FR-7: current password required.
async function changePassword(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const cur = $("set-pass-cur").value;
  const pw = $("set-pass-1").value;
  if (!cur) return err("Enter your current password.");
  const pwErr = passwordProblem(pw);
  if (pwErr) return err(pwErr);
  if (pw !== $("set-pass-2").value) return err("The new passwords don't match.");
  if (pw === cur) return err("The new password must be different.");

  await busy(form, async () => {
    const { data: ok, error: checkErr } = await sb.rpc("check_password", { p_password: cur });
    if (checkErr) return err(checkErr.message);
    if (!ok) return err("Your current password is wrong.");
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) return err(error.message);
    await sb.rpc("password_changed");
    form.reset();
    err("");
    toast("Password changed.");
  });
}

async function verifiedFactors() {
  const { data } = await sb.auth.mfa.listFactors();
  return (data?.totp ?? []).filter((f) => f.status === "verified");
}

async function paintMfa() {
  const me = currentUser();
  const factors = await verifiedFactors();
  $("set-mfa-state").textContent = factors.length
    ? `On, with ${factors.length} authenticator${factors.length > 1 ? "s" : ""}.` +
      (me.role === "admin" ? " Required for the admin account." : "")
    : "Off. Turn it on so a stolen password alone can't get into your account.";
  $("set-mfa-add").textContent = factors.length ? "Add a backup authenticator" : "Set up 2FA";
  $("set-mfa-remove").hidden = !factors.length || me.role === "admin";
}

function addMfa() {
  dlg().close();
  showEnroll({ overlay: true, onDone: () => {} });
}

async function removeMfa() {
  if (!confirm("Turn off two-factor authentication?")) return;
  for (const f of await verifiedFactors()) {
    const { error } = await sb.auth.mfa.unenroll({ factorId: f.id });
    if (error) return err(error.message);
  }
  await sb.auth.refreshSession();
  toast("Two-factor authentication is off.");
  paintMfa();
}

function paintNotifications() {
  const state = notificationState();
  $("set-notif-state").textContent = {
    unsupported: "This browser doesn't support notifications. On iPhone, add the app to your Home Screen first.",
    granted: "On. You'll get a notification for new messages while the app is in the background.",
    denied: "Blocked. Allow notifications for this site in your browser settings.",
    default: "Get a notification for new messages while the app is in the background.",
  }[state];
  $("set-notif").hidden = state !== "default";
}
