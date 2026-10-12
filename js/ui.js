// DOM and formatting helpers shared by every screen.

export const $ = (id) => document.getElementById(id);

const SCREENS = ["login", "mfa", "signup", "notice", "enroll", "newpass", "app"];

export function showScreen(name) {
  for (const s of SCREENS) $("screen-" + s).hidden = s !== name;
  const first = $("screen-" + name).querySelector("input:not([type=hidden])");
  if (first && name !== "app") setTimeout(() => first.focus(), 0);
}

// Overlay one gate screen on top of the app without hiding it (used for
// setting up 2FA from Settings).
export function overlayScreen(name, on) { $("screen-" + name).hidden = !on; }

export function formError(form, msg) {
  const p = form.querySelector(".gate-error");
  if (p) p.textContent = msg || "";
}

// Disable a form's buttons while an async action runs.
export async function busy(form, fn) {
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try { return await fn(); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// Tiny element builder: h("div", { className: "x", onclick }, child, "text")
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") el.style.cssText = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Turn bare URLs into links without ever touching innerHTML (FR-18).
export function linkify(text, container) {
  const re = /(https?:\/\/[^\s<>"']+)/g;
  let i = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > i) container.appendChild(document.createTextNode(text.slice(i, m.index)));
    container.appendChild(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0]));
    i = m.index + m[0].length;
  }
  if (i < text.length) container.appendChild(document.createTextNode(text.slice(i)));
}

// The async Clipboard API needs a secure context and a real user gesture, and
// is blocked outright in some embedded browsers. Fall back to the old
// execCommand path so "copy" works everywhere rather than dead-ending.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Every name gets one stable colour, picked by hashing it, so a person looks
// the same on every device and across reloads.
const COLORS = [
  "#3e63dd", "#46a758", "#d6409f", "#8e4ec6",
  "#0d9488", "#d97706", "#e5484d", "#0b7285",
  "#7c3aed", "#b45309", "#be123c", "#15803d",
  "#1d4ed8", "#a21caf", "#047857", "#c2410c",
];

export function colorFor(name) {
  let x = 2166136261;                       // FNV-1a
  for (let i = 0; i < name.length; i++) {
    x ^= name.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return COLORS[x % COLORS.length];
}

// "Work PC" -> "WP", "alice" -> "A"
export function initialsFor(name) {
  const parts = name.trim().split(/[\s_]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function avatar(name, size = 18) {
  const el = h("span", { className: "avatar" }, initialsFor(name));
  el.style.backgroundColor = colorFor(name);
  el.style.width = el.style.height = size + "px";
  el.style.fontSize = Math.round(size / 2) + "px";
  return el;
}

export function safeName(name) { return name.replace(/[^\w.\-]+/g, "_").slice(-80) || "file"; }

export function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTimeLabel(ts) {
  return new Date(ts).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
