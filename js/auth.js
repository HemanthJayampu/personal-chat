// Screens 1-3 plus 2FA and forced password change (5.1, 7.7).
import { sb, usernameToEmail, USERNAME_RE, passwordProblem, callFunction } from "./supabase.js";
import { $, showScreen, overlayScreen, formError, busy, toast } from "./ui.js";
import { route, signOut, markActive } from "./session.js";

export function initAuth() {
  document.querySelectorAll("[data-go]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); showScreen(a.dataset.go); }));
  document.querySelectorAll("[data-action=signout]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); signOut(); }));

  // Usernames are lowercase; fix it as they type rather than reject it.
  for (const id of ["login-user", "signup-user"]) {
    $(id).addEventListener("input", (e) => {
      const v = e.target.value.toLowerCase();
      if (v !== e.target.value) e.target.value = v;
    });
  }

  $("login-form").addEventListener("submit", onLogin);
  $("signup-form").addEventListener("submit", onSignup);
  $("mfa-form").addEventListener("submit", onMfa);
  $("enroll-form").addEventListener("submit", onEnrollVerify);
  $("enroll-cancel").addEventListener("click", onEnrollCancel);
  $("newpass-form").addEventListener("submit", onNewPassword);
  $("notice-action").addEventListener("click", () => noticeAction?.());
}

// ---------------------------------------------------------------------------
// login (FR-5)
// ---------------------------------------------------------------------------
async function onLogin(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const username = $("login-user").value.trim();
  const password = $("login-pass").value;
  if (!username || !password) return formError(form, "Enter your username and password.");
  if (!USERNAME_RE.test(username)) return formError(form, "Wrong username or password.");

  formError(form, "Signing in…");
  await busy(form, async () => {
    const { error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
    if (error) {
      formError(form,
        error.status === 429 || /rate limit|too many/i.test(error.message)
          ? "Too many attempts. Wait a few minutes and try again."
          : /invalid login/i.test(error.message) ? "Wrong username or password."
          : error.message);
      $("login-pass").select();
      return;
    }
    formError(form, "");
    $("login-pass").value = "";
    markActive();
    sb.rpc("log_login").then(() => {}, () => {});     // 7.10, best effort
    await route();
  });
}

// ---------------------------------------------------------------------------
// sign up (FR-1 .. FR-4) -- goes through the Edge Function only
// ---------------------------------------------------------------------------
async function onSignup(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const username = $("signup-user").value.trim();
  const password = $("signup-pass").value;
  const code = $("signup-code").value.trim();

  if (!USERNAME_RE.test(username)) {
    return formError(form, "Username must be 3–20 characters: lowercase letters, numbers and _.");
  }
  const pwErr = passwordProblem(password);
  if (pwErr) return formError(form, pwErr);
  if (password !== $("signup-pass2").value) return formError(form, "The passwords don't match.");
  if (!code) return formError(form, "Enter your invite code.");

  formError(form, "Creating your account…");
  await busy(form, async () => {
    try {
      await callFunction("signup-with-invite", { username, password, invite_code: code });
    } catch (err) {
      return formError(form, err.message);
    }
    form.reset();
    formError(form, "");
    // Sign straight in; the router shows "Waiting for approval".
    const { error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
    if (error) {
      $("login-user").value = username;
      showScreen("login");
      formError($("login-form"), "Account created. Sign in to check your approval status.");
      return;
    }
    markActive();
    await route();
  });
}

// ---------------------------------------------------------------------------
// 2FA: second login step
// ---------------------------------------------------------------------------
export function showMfa() {
  $("mfa-form").reset();
  formError($("mfa-form"), "");
  showScreen("mfa");
}

async function onMfa(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const code = $("mfa-code").value.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return formError(form, "Enter the 6-digit code.");

  await busy(form, async () => {
    const { data, error: listErr } = await sb.auth.mfa.listFactors();
    const factor = data?.totp?.find((f) => f.status === "verified");
    if (listErr || !factor) return formError(form, listErr?.message || "No authenticator is set up for this account.");

    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) {
      $("mfa-code").select();
      return formError(form, /invalid/i.test(error.message)
        ? "That code didn't work. Check your phone's clock and try the next code."
        : error.message);
    }
    markActive();
    await route();
  });
}

// ---------------------------------------------------------------------------
// 2FA enrolment: mandatory for admin at login, optional from Settings
// ---------------------------------------------------------------------------
let enrolling = null;   // { factorId, mandatory, overlay, onDone }

export async function showEnroll({ mandatory = false, overlay = false, onDone } = {}) {
  const form = $("enroll-form");
  form.reset();
  formError(form, "");
  $("enroll-why").textContent = mandatory
    ? "The admin account must use two-factor authentication. Set it up to continue."
    : "Adds a 6-digit code from your phone to every sign-in.";
  $("enroll-cancel").textContent = mandatory ? "Sign out" : "Cancel";
  $("enroll-qr").removeAttribute("src");
  $("enroll-secret").textContent = "Loading…";

  if (overlay) overlayScreen("enroll", true); else showScreen("enroll");

  // A half-finished enrolment blocks a new one; clear it out first.
  const { data: list } = await sb.auth.mfa.listFactors();
  for (const f of list?.all ?? []) {
    if (f.factor_type === "totp" && f.status !== "verified") await sb.auth.mfa.unenroll({ factorId: f.id });
  }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const { data, error } = await sb.auth.mfa.enroll({
    factorType: "totp", issuer: "Personal Chat", friendlyName: `Authenticator ${stamp}`,
  });
  if (error) {
    $("enroll-secret").textContent = "";
    return formError(form, error.message);
  }
  $("enroll-qr").src = data.totp.qr_code;
  $("enroll-secret").textContent = data.totp.secret;
  enrolling = { factorId: data.id, mandatory, overlay, onDone };
}

async function onEnrollVerify(e) {
  e.preventDefault();
  const form = e.currentTarget;
  if (!enrolling) return;
  const code = $("enroll-code").value.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return formError(form, "Enter the 6-digit code.");

  await busy(form, async () => {
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enrolling.factorId, code });
    if (error) {
      $("enroll-code").select();
      return formError(form, /invalid/i.test(error.message)
        ? "That code didn't work. Check your phone's clock and try the next code."
        : error.message);
    }
    const done = enrolling;
    enrolling = null;
    if (done.overlay) overlayScreen("enroll", false);
    toast("Two-factor authentication is on.");
    await done.onDone?.();
  });
}

async function onEnrollCancel(e) {
  e.preventDefault();
  const was = enrolling;
  enrolling = null;
  if (was?.factorId) await sb.auth.mfa.unenroll({ factorId: was.factorId }).catch(() => {});
  if (!was || was.mandatory) return signOut();
  if (was.overlay) overlayScreen("enroll", false);
}

// ---------------------------------------------------------------------------
// forced change after an admin reset (7.7)
// ---------------------------------------------------------------------------
async function onNewPassword(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const pw = $("newpass-1").value;
  const pwErr = passwordProblem(pw);
  if (pwErr) return formError(form, pwErr);
  if (pw !== $("newpass-2").value) return formError(form, "The passwords don't match.");

  await busy(form, async () => {
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) return formError(form, error.message);
    await sb.rpc("password_changed");
    form.reset();
    formError(form, "");
    toast("Password changed.");
    await route();
  });
}

// ---------------------------------------------------------------------------
// generic notice screen (pending approval, disabled, errors)
// ---------------------------------------------------------------------------
let noticeAction = null;

export function showNotice(title, body, actionLabel, action) {
  $("notice-title").textContent = title;
  $("notice-body").textContent = body;
  $("notice-action").textContent = actionLabel;
  noticeAction = action;
  showScreen("notice");
}
