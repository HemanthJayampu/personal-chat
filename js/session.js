// Decides which screen a visitor sees, and owns sign-out and the idle timer.
import { sb } from "./supabase.js";
import { $, showScreen } from "./ui.js";
import { IDLE_TIMEOUT_MINUTES } from "../config.js";
import { showMfa, showEnroll, showNotice } from "./auth.js";
import { startChat, stopChat } from "./chat.js";

let routeSeq = 0;
let approvalPoll = null;
let loginNotice = "";

export async function route() {
  const seq = ++routeSeq;
  clearInterval(approvalPoll);

  const { data: { session } } = await sb.auth.getSession();
  if (seq !== routeSeq) return;

  if (!session) {
    stopChat();
    stopIdleWatch();
    showScreen("login");
    const err = $("login-form").querySelector(".gate-error");
    err.textContent = loginNotice;   // kept until the next successful sign-in
    return;
  }

  if (idleExpired()) return signOut(`Signed out after ${IDLE_TIMEOUT_MINUTES} minutes of inactivity.`);
  startIdleWatch();

  const { data: aal, error: aalErr } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (seq !== routeSeq) return;
  if (aalErr) return showNotice("Can't reach the server", aalErr.message, "Try again", route);
  if (aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") return showMfa();

  const { data: profile, error } = await sb.from("profiles").select("*")
    .eq("id", session.user.id).maybeSingle();
  if (seq !== routeSeq) return;
  if (error) return showNotice("Can't reach the server", error.message, "Try again", route);

  if (!profile) {
    return showNotice("Account not set up",
      "This login has no chat profile. Ask the admin to check your account.", "Sign out", () => signOut());
  }
  if (profile.status === "pending") {
    // 7.3: nothing but this screen until the admin approves. Re-check
    // every 15 s so the app opens by itself once approved.
    approvalPoll = setInterval(async () => {
      const { data } = await sb.from("profiles").select("status").eq("id", profile.id).maybeSingle();
      if (data && data.status !== "pending") route();
    }, 15000);
    return showNotice("Waiting for approval",
      `Hi ${profile.username}, your account has been created. The admin needs to approve it before you can chat. This page will open the app automatically once you're approved.`,
      "Sign out", () => signOut());
  }
  if (profile.status === "disabled") {
    stopChat();
    return showNotice("Account disabled",
      "Your account has been disabled by the admin.", "Sign out", () => signOut());
  }
  // FR-5 / 7.7: 2FA is mandatory for the admin.
  if (profile.role === "admin" && aal.currentLevel !== "aal2") {
    stopChat();
    return showEnroll({ mandatory: true, onDone: route });
  }
  if (profile.must_change_password) {
    stopChat();
    return showScreen("newpass");
  }

  await startChat(profile);
  if (seq === routeSeq) showScreen("app");
}

// scope "global" signs out every device (FR-6).
export async function signOut(notice = "", scope = "local") {
  loginNotice = notice;
  stopChat();
  stopIdleWatch();
  try { localStorage.removeItem(ACTIVITY_KEY); } catch { /* storage blocked */ }
  await sb.auth.signOut({ scope });
  await route();
}

// ---------------------------------------------------------------------------
// 7.6: app-side idle timeout. The last-activity time is shared through
// localStorage, so using the app in one tab keeps the others signed in, and
// coming back to a closed browser after 30 minutes means signing in again.
// ---------------------------------------------------------------------------
const ACTIVITY_KEY = "chat.lastActivity";
const LIMIT_MS = IDLE_TIMEOUT_MINUTES * 60 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];
let idleTimer = null;
let lastWrite = 0;

function readActivity() {
  try { return Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch { return 0; }
}

export function markActive() {
  loginNotice = "";
  lastWrite = Date.now();
  try { localStorage.setItem(ACTIVITY_KEY, String(lastWrite)); } catch { /* storage blocked */ }
}

function onActivity() { if (Date.now() - lastWrite > 10000) markActive(); }

function idleExpired() {
  const t = readActivity();
  return t > 0 && Date.now() - t > LIMIT_MS;
}

function checkIdle() {
  if (idleExpired()) signOut(`Signed out after ${IDLE_TIMEOUT_MINUTES} minutes of inactivity.`);
}

function onVisible() { if (!document.hidden) checkIdle(); }

function startIdleWatch() {
  if (idleTimer) return;
  if (!readActivity()) markActive();
  ACTIVITY_EVENTS.forEach((e) => addEventListener(e, onActivity, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", onVisible);
  idleTimer = setInterval(checkIdle, 30000);
}

function stopIdleWatch() {
  if (!idleTimer) return;
  ACTIVITY_EVENTS.forEach((e) => removeEventListener(e, onActivity, { capture: true }));
  document.removeEventListener("visibilitychange", onVisible);
  clearInterval(idleTimer);
  idleTimer = null;
}
