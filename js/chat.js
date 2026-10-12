// Screen 4 (chat home) and 5 (new chat): 5.3, 5.4, 5.5.
import { sb } from "./supabase.js";
import {
  $, h, avatar, colorFor, linkify, copyText, fmtSize, timeLabel, dayLabel, toast, formError,
} from "./ui.js";
import { uploadFile, signedUrl, deleteFile, download, sizeProblem } from "./files.js";
import { notify, setAppBadge } from "./notify.js";
import { route } from "./session.js";
import { refreshPendingBadge } from "./admin.js";

const PAGE_SIZE  = 50;
const BASE_TITLE = "Personal Chat";

let me = null;                 // my profile row
let channel = null;
let wired = false;
const people = new Map();      // user id -> { username, display_name, status }
let convs = [];                // rows from conversation_list()
let active = null;             // the open conversation
let members = [];              // conversation_members rows of the open conversation
const shown = new Map();       // message id -> element, for the open conversation
let oldestId = null;
let hasMore = false;
let loadingOlder = false;
let openSeq = 0;
let attached = null;           // File staged for sending
let attachedPreview = null;    // object URL for its thumbnail
let readTimer = null;

export const currentUser = () => me;

export function updateMe(patch) {
  me = { ...me, ...patch };
  paintMe();
  refreshConvs();
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
export async function startChat(profile) {
  const sameUser = me?.id === profile.id && channel;
  me = profile;
  if (!wired) { wire(); wired = true; }
  paintMe();
  $("btn-admin").hidden = me.role !== "admin";
  if (sameUser) return;

  await loadPeople();
  await refreshConvs();
  subscribe();
  if (me.role === "admin") refreshPendingBadge();

  let last = null;
  try { last = localStorage.getItem("chat.activeConv"); } catch { /* storage blocked */ }
  const target = convs.find((c) => c.id === last) || convs.find((c) => c.type === "self") || convs[0];
  if (target) await openConv(target.id);
}

export function stopChat() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  me = null; active = null; convs = []; members = [];
  people.clear(); shown.clear();
  clearAttachment();
  $("log").replaceChildren();
  $("conv-list").replaceChildren();
  document.body.classList.remove("show-pane");
  document.title = BASE_TITLE;
  setAppBadge(0);
}

// ---------------------------------------------------------------------------
// people and conversations
// ---------------------------------------------------------------------------
async function loadPeople() {
  const { data, error } = await sb.from("profiles").select("id, username, display_name, status");
  if (error) return console.error(error);
  people.clear();
  for (const p of data) people.set(p.id, p);
}

function nameOf(id) {
  if (!id) return "Deleted user";
  if (id === me?.id) return me.display_name || me.username;
  const p = people.get(id);
  return p ? (p.display_name || p.username) : "Deleted user";
}

async function refreshConvs() {
  const { data, error } = await sb.rpc("conversation_list");
  if (error) { console.error(error); setStatus("down"); return; }
  // Keep the open conversation's local "read" state; the server catches up
  // when mark_read lands.
  convs = data.map((c) => (active && c.id === active.id && !document.hidden ? { ...c, unread: 0 } : c));
  if (active) active = convs.find((c) => c.id === active.id) || active;
  paintList();
  paintTitle();
}

function sortConvs() {
  convs.sort((a, b) => {
    if (a.type === "self") return -1;            // My Devices stays on top
    if (b.type === "self") return 1;
    return (b.last_message_at || "").localeCompare(a.last_message_at || "");
  });
}

function convSub(c) {
  if (c.type === "self") return "Notes and transfers between your devices";
  if (c.type === "group") return `${c.member_count} members`;
  const p = people.get(c.peer_id);
  return p ? "@" + p.username : "";
}

function convIcon(c) {
  if (c.type !== "self") return avatar(c.title, 34);
  const el = h("span", { className: "avatar self" });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="2" y="4" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M1 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="17" y="8" width="6" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
  return el;
}

function paintList() {
  sortConvs();
  $("conv-list").replaceChildren(...convs.map((c) =>
    h("li", {},
      h("button", {
        type: "button",
        className: "conv" + (active?.id === c.id ? " active" : ""),
        onclick: () => openConv(c.id, { userAction: true }),
      },
        convIcon(c),
        h("span", { className: "conv-text" },
          h("span", { className: "conv-name" }, c.title),
          h("span", { className: "conv-sub" }, convSub(c))),
        c.unread > 0 ? h("span", { className: "badge" }, c.unread > 99 ? "99+" : c.unread) : null))));
}

function paintMe() {
  if (!me) return;
  const name = me.display_name || me.username;
  $("me-avatar").replaceChildren(avatar(name, 28));
  $("me-name").textContent = name;
}

function paintTitle() {
  const total = convs.reduce((n, c) => n + (c.unread || 0), 0);
  document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
  setAppBadge(total);
}

// ---------------------------------------------------------------------------
// opening a conversation and paging history (FR-16)
// ---------------------------------------------------------------------------
async function openConv(id, { userAction = false } = {}) {
  const c = convs.find((x) => x.id === id);
  if (!c) return;
  const seq = ++openSeq;
  active = c;
  try { localStorage.setItem("chat.activeConv", id); } catch { /* storage blocked */ }

  shown.clear();
  oldestId = null; hasMore = false;
  $("log").replaceChildren(h("div", { className: "loading" }, "Loading…"));
  $("conv-title").textContent = c.title;
  $("conv-sub").textContent = convSub(c);
  clearAttachment();
  if (userAction) document.body.classList.add("show-pane");
  paintList();

  const [memRes, msgs] = await Promise.all([
    sb.from("conversation_members").select("user_id, last_read_at").eq("conversation_id", id),
    fetchPage(id),
  ]);
  if (seq !== openSeq) return;

  members = memRes.data || [];
  $("log").replaceChildren();
  msgs.reverse().forEach((m) => addMessage(m, { scroll: false }));
  oldestId = msgs[0]?.id ?? null;
  hasMore = msgs.length === PAGE_SIZE;
  if (!hasMore) $("log").prepend(startMarker());
  fixDays();
  scrollToEnd();
  markRead();
  if (userAction || matchMedia("(min-width: 760px)").matches) $("text").focus();
}

async function fetchPage(convId, beforeId) {
  let q = sb.from("messages").select("*, file:files(*)")
    .eq("conversation_id", convId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE);
  if (beforeId) q = q.lt("id", beforeId);
  const { data, error } = await q;
  if (error) { console.error(error); toast("Couldn't load messages."); return []; }
  return data;
}

async function loadOlder() {
  if (!active || !hasMore || loadingOlder) return;
  loadingOlder = true;
  const seq = openSeq;
  const log = $("log");
  try {
    const older = await fetchPage(active.id, oldestId);
    if (seq !== openSeq) return;
    const prevHeight = log.scrollHeight;
    const anchor = log.firstChild;
    for (const m of older.reverse()) {
      if (shown.has(m.id)) continue;
      const el = messageNode(m);
      shown.set(m.id, el);
      log.insertBefore(el, anchor);
    }
    oldestId = older[0]?.id ?? oldestId;
    hasMore = older.length === PAGE_SIZE;
    if (!hasMore) log.prepend(startMarker());
    fixDays();
    refreshTicks();
    log.scrollTop += log.scrollHeight - prevHeight;   // keep the reader's place
  } finally {
    loadingOlder = false;
  }
}

function startMarker() {
  return h("div", { className: "start" }, active?.type === "self"
    ? "This is your space. Anything you send here shows up on all your signed-in devices."
    : "Start of the conversation");
}

// ---------------------------------------------------------------------------
// realtime (FR-15). RLS decides which rows each user hears about.
// ---------------------------------------------------------------------------
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("chat-" + me.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" },
        (p) => onInsert(p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" },
        (p) => onUpdate(p.new))
    .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members" },
        (p) => onMember(p))
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" },
        (p) => onProfile(p))
    .subscribe((state) => {
      if (state === "SUBSCRIBED") { setStatus("live"); catchUp(); }
      else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") setStatus("down");
    });
}

async function onInsert(m) {
  if (!me) return;
  let c = convs.find((x) => x.id === m.conversation_id);
  if (!c) { await refreshConvs(); c = convs.find((x) => x.id === m.conversation_id); }
  if (!c) return;

  if (m.file_id && !m.file) {
    const { data } = await sb.from("files").select("*").eq("id", m.file_id).maybeSingle();
    m.file = data;
  }

  c.last_message_at = m.created_at;
  const fromOther = m.sender_id !== me.id;

  if (active?.id === m.conversation_id) {
    addMessage(m);
    if (fromOther) {
      if (document.hidden || !document.hasFocus()) c.unread = (c.unread || 0) + 1;
      else markRead();
    }
  } else if (fromOther) {
    c.unread = (c.unread || 0) + 1;
  }
  paintList();
  paintTitle();

  if (fromOther && document.hidden) {
    const who = nameOf(m.sender_id);
    const text = m.content || (m.file ? `📎 ${m.file.file_name}` : "New message");
    notify(c.type === "direct" ? who : `${who} · ${c.title}`, text.slice(0, 140), m.conversation_id);
  }
}

function onUpdate(m) {
  const el = shown.get(m.id);
  if (!el) return;
  const fresh = messageNode({ ...m, file: m.file_id ? el._msg?.file : null });
  shown.set(m.id, fresh);
  el.replaceWith(fresh);
  refreshTicks();
}

function onMember(p) {
  const row = p.new && Object.keys(p.new).length ? p.new : p.old;
  if (p.eventType === "UPDATE" && active && row.conversation_id === active.id) {
    const i = members.findIndex((x) => x.user_id === row.user_id);
    if (i >= 0) members[i] = { ...members[i], last_read_at: row.last_read_at };
    refreshTicks();
    return;
  }
  if (p.eventType !== "UPDATE") refreshConvs();     // added to / removed from a chat
}

function onProfile(p) {
  const row = p.new && Object.keys(p.new).length ? p.new : null;
  if (row && row.id === me?.id) {
    // 13: a disabled user loses access immediately, including this screen.
    if (row.status !== "approved" || row.role !== me.role) return route();
    me = { ...me, ...row };
    paintMe();
    return;
  }
  if (row) people.set(row.id, { ...people.get(row.id), ...row });
  if (me?.role === "admin") refreshPendingBadge();
}

// Anything that landed while the tab was asleep or offline.
async function catchUp() {
  await refreshConvs();
  if (!active) return;
  const maxId = Math.max(0, ...shown.keys());
  if (!maxId) return;
  const { data, error } = await sb.from("messages").select("*, file:files(*)")
    .eq("conversation_id", active.id).gt("id", maxId).order("id", { ascending: true });
  if (error) return console.error(error);
  data.forEach((m) => addMessage(m));
  const { data: mem } = await sb.from("conversation_members").select("user_id, last_read_at")
    .eq("conversation_id", active.id);
  if (mem) { members = mem; refreshTicks(); }
  markRead();
}

function setStatus(kind) {
  $("status").className = "status " + kind;
  $("status").title = kind === "live" ? "Connected" : "Reconnecting…";
}

// FR-25: unread is "messages from others newer than my last_read_at".
function markRead() {
  if (!me || !active || document.hidden) return;
  const c = active;
  if (c.unread) { c.unread = 0; paintList(); paintTitle(); }
  clearTimeout(readTimer);
  readTimer = setTimeout(() => sb.rpc("mark_read", { p_conv: c.id }).then(({ error }) => {
    if (error) console.error(error);
  }), 400);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
function addMessage(m, { scroll = true } = {}) {
  if (shown.has(m.id)) return;
  const log = $("log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const el = messageNode(m);
  shown.set(m.id, el);
  log.querySelector(".loading")?.remove();
  log.appendChild(el);
  fixDays();
  if (m.sender_id === me.id) refreshTicks();
  if (scroll && (nearBottom || m.sender_id === me.id)) scrollToEnd();
}

function messageNode(m) {
  const mine = m.sender_id === me.id;
  const wrap = h("div", {
    className: "msg" + (mine ? " mine" : "") + (m.deleted_at ? " deleted" : ""),
    dataset: { id: m.id, ts: m.created_at },
  });
  wrap._msg = m;

  if (active?.type === "group" && !mine) wrap.appendChild(senderTag(nameOf(m.sender_id)));

  const bubble = h("div", { className: "bubble" });
  if (m.deleted_at) {
    bubble.appendChild(h("em", {}, "Message deleted"));
  } else {
    if (m.file) bubble.appendChild(fileNode(m.file));
    else if (!m.content) bubble.appendChild(h("em", {}, "Attachment expired"));
    if (m.content) {
      const p = h("div", { className: m.file ? "text with-file" : "text" });
      linkify(m.content, p);
      bubble.appendChild(p);
    }
  }
  wrap.appendChild(bubble);

  const meta = h("div", { className: "meta" }, timeLabel(m.created_at));
  if (m.content && !m.deleted_at) {
    const copy = h("button", { type: "button", className: "linkish" }, "copy");
    copy.onclick = async () => {
      copy.textContent = (await copyText(m.content)) ? "copied" : "failed";
      setTimeout(() => (copy.textContent = "copy"), 1400);
    };
    meta.appendChild(copy);
  }
  if (mine && !m.deleted_at) {
    meta.appendChild(h("button", { type: "button", className: "linkish", onclick: () => removeMessage(m) }, "delete"));
    if (active?.type !== "self") meta.appendChild(h("span", { className: "tick sent", title: "Sent" }, "✓"));
  }
  wrap.appendChild(meta);
  return wrap;
}

function senderTag(name) {
  const color = colorFor(name);
  const label = h("span", { className: "who-name" }, name);
  label.style.color = color;
  return h("div", { className: "who" }, avatar(name), label);
}

const isImage = (f) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.mime_type || "")
  || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.file_name || "");

function fileNode(f) {
  const holder = h("div", { className: "file" });
  const row = h("a", {
    className: "file-row", href: "#", title: "Download",
    onclick: async (e) => {
      e.preventDefault();
      try { await download(f); } catch (err) { toast(err.message); }
    },
  });
  row.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"
            fill="none" stroke="currentColor" stroke-width="1.7"
            stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const expires = new Date(f.expires_at).toLocaleDateString([], { day: "numeric", month: "short" });
  row.appendChild(h("span", {},
    h("div", { className: "fname" }, f.file_name),
    h("div", { className: "fsize" }, `${fmtSize(f.size_bytes)} · until ${expires}`)));
  holder.appendChild(row);

  // FR-21: image preview, loaded through a short-lived signed URL.
  if (isImage(f)) {
    signedUrl(f.storage_path).then((url) => {
      if (!url) return;
      const img = h("img", { className: "thumb", src: url, alt: f.file_name, loading: "lazy" });
      holder.appendChild(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, img));
    });
  }
  return holder;
}

// One date pill wherever the day changes.
function fixDays() {
  const log = $("log");
  log.querySelectorAll(".day").forEach((d) => d.remove());
  let prev = "";
  for (const el of log.querySelectorAll(".msg[data-ts]")) {
    const day = new Date(el.dataset.ts).toDateString();
    if (day !== prev) {
      el.before(h("div", { className: "day" }, dayLabel(el.dataset.ts)));
      prev = day;
    }
  }
}

// ✓ sent, ✓✓ (blue) once everyone else has read up to it.
function refreshTicks() {
  if (!active || active.type === "self") return;
  const others = members.filter((x) => x.user_id !== me.id);
  const readUpTo = others.length
    ? Math.min(...others.map((o) => (o.last_read_at ? Date.parse(o.last_read_at) : 0)))
    : 0;
  for (const el of $("log").querySelectorAll(".msg.mine[data-id]")) {
    const tick = el.querySelector(".tick");
    if (!tick) continue;
    const seen = readUpTo >= Date.parse(el.dataset.ts);
    tick.textContent = seen ? "✓✓" : "✓";
    tick.className = "tick " + (seen ? "seen" : "sent");
    tick.title = seen ? (others.length > 1 ? "Seen by everyone" : "Seen") : "Sent";
  }
}

function scrollToEnd() { const log = $("log"); log.scrollTop = log.scrollHeight; }

// ---------------------------------------------------------------------------
// sending (FR-19 .. FR-21)
// ---------------------------------------------------------------------------
async function send() {
  const body = $("text").value.trim();
  const file = attached;
  if ((!body && !file) || !active) return;
  if (body.length > 5000) return toast("Messages can be at most 5000 characters.");

  const convId = active.id;
  $("send").disabled = true;
  $("text").value = ""; $("text").style.height = "auto";
  clearAttachment();

  try {
    let fileRow = null;
    if (file) {
      showUpload(file.name);
      fileRow = await uploadFile(convId, me.id, file, (p) => ($("upload-bar").value = p));
    }
    const { data, error } = await sb.from("messages")
      .insert({ conversation_id: convId, sender_id: me.id, content: body || null, file_id: fileRow?.id ?? null })
      .select("*, file:files(*)").single();
    if (error) throw error;
    if (active?.id === convId) addMessage(data);
  } catch (err) {
    console.error(err);
    if (active?.id === convId) renderFailed(body, file, err.message);
    else toast("Message not sent: " + err.message);
  } finally {
    $("upload").hidden = true;
    $("send").disabled = false;
    $("text").focus();
  }
}

function showUpload(name) {
  $("upload-name").textContent = `Uploading ${name}`;
  $("upload-bar").value = 0;
  $("upload").hidden = false;
}

function renderFailed(body, file, why) {
  const retry = h("button", { type: "button", className: "retry" }, "retry");
  const wrap = h("div", { className: "msg mine failed" },
    h("div", { className: "bubble" }, (body || file?.name || "message") + " — not sent", retry),
    h("div", { className: "meta" }, why || "offline"));
  retry.onclick = () => {
    wrap.remove();
    $("text").value = body || "";
    if (file) stage(file);
    send();
  };
  $("log").appendChild(wrap);
  scrollToEnd();
}

// FR-17: soft delete; the attached file leaves storage straight away.
async function removeMessage(m) {
  if (!confirm(m.file ? "Delete this message and its file?" : "Delete this message?")) return;
  const { error } = await sb.from("messages").update({ deleted_at: new Date().toISOString() }).eq("id", m.id);
  if (error) return toast("Couldn't delete: " + error.message);
  if (m.file) {
    try { await deleteFile(m.file); } catch (err) { console.error(err); }
  }
  onUpdate({ ...m, deleted_at: new Date().toISOString(), content: null, file_id: null });
}

function stage(f) {
  if (!f) return;
  const tooBig = sizeProblem(f);
  if (tooBig) { toast(tooBig, 4000); $("file").value = ""; return; }
  clearAttachment();
  attached = f;
  $("pending-file-name").textContent = `${f.name} (${fmtSize(f.size)})`;
  if (f.type.startsWith("image/")) {
    attachedPreview = URL.createObjectURL(f);
    $("pending-thumb").src = attachedPreview;
    $("pending-thumb").hidden = false;
  }
  $("pending-file").hidden = false;
  $("text").focus();
}

function clearAttachment() {
  attached = null;
  $("file").value = "";
  $("pending-file").hidden = true;
  $("pending-thumb").hidden = true;
  $("pending-thumb").removeAttribute("src");
  if (attachedPreview) { URL.revokeObjectURL(attachedPreview); attachedPreview = null; }
}

// Pasted images arrive as "image.png" -- give them a unique, sortable name.
function namedFile(f) {
  if (f.name && f.name !== "image.png") return f;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new File([f], `pasted-${stamp}.${ext}`, { type: f.type });
}

// ---------------------------------------------------------------------------
// new chat dialog (screen 5)
// ---------------------------------------------------------------------------
const picked = new Set();

function openNewChat() {
  picked.clear();
  $("newchat-filter").value = "";
  $("newchat-name").value = "";
  formError($("newchat-form"), "");
  paintPeople();
  syncNewChat();
  $("dlg-newchat").showModal();
  $("newchat-filter").focus();
}

function paintPeople() {
  const q = $("newchat-filter").value.trim().toLowerCase();
  const list = [...people.entries()]
    .filter(([id, p]) => id !== me.id && p.status === "approved")
    .filter(([, p]) => !q || p.username.includes(q) || (p.display_name || "").toLowerCase().includes(q))
    .sort(([, a], [, b]) => a.username.localeCompare(b.username));

  $("newchat-people").replaceChildren(...(list.length ? list.map(([id, p]) => {
    const box = h("input", { type: "checkbox", checked: picked.has(id) });
    box.onchange = () => { box.checked ? picked.add(id) : picked.delete(id); syncNewChat(); };
    return h("li", {}, h("label", { className: "person" }, box, avatar(p.display_name || p.username, 26),
      h("span", {}, p.display_name || p.username, " ", h("small", {}, "@" + p.username))));
  }) : [h("li", { className: "empty" }, q ? "Nobody matches." : "No other approved users yet. Create an invite code in Admin.")]));
}

function syncNewChat() {
  $("newchat-group").hidden = picked.size < 2;
  $("newchat-create").disabled = picked.size === 0;
  $("newchat-create").textContent = picked.size > 1 ? "Create group" : "Start chat";
}

async function createChat(e) {
  if (e.submitter?.value !== "create") return;   // Cancel / ✕ just close
  e.preventDefault();
  const form = e.currentTarget;
  const type = picked.size > 1 ? "group" : "direct";
  const { data: id, error } = await sb.rpc("create_conversation", {
    p_type: type, p_name: $("newchat-name").value, p_members: [...picked],
  });
  if (error) return formError(form, error.message);
  $("dlg-newchat").close();
  await refreshConvs();
  await openConv(id, { userAction: true });
}

// ---------------------------------------------------------------------------
// one-time DOM wiring
// ---------------------------------------------------------------------------
function wire() {
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("text").addEventListener("input", () => {
    const t = $("text");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 140) + "px";
  });

  $("file").addEventListener("change", () => stage($("file").files[0]));
  $("pending-file-clear").addEventListener("click", clearAttachment);

  // Paste a screenshot or file straight into the box.
  $("text").addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === "file");
    const f = item?.getAsFile();
    if (!f) return;                               // plain text paste, let it through
    e.preventDefault();
    stage(namedFile(f));
  });

  // Drag and drop anywhere on the window.
  const appHidden = () => $("screen-app").hidden || !active;
  ["dragenter", "dragover"].forEach((ev) => addEventListener(ev, (e) => {
    if (appHidden() || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    $("dropzone").hidden = false;
  }));
  addEventListener("dragleave", (e) => { if (e.relatedTarget === null) $("dropzone").hidden = true; });
  addEventListener("drop", (e) => {
    if (appHidden()) return;
    e.preventDefault();
    $("dropzone").hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) stage(f);
  });

  $("log").addEventListener("scroll", () => { if ($("log").scrollTop < 150) loadOlder(); }, { passive: true });

  $("btn-back").addEventListener("click", () => document.body.classList.remove("show-pane"));
  $("btn-newchat").addEventListener("click", openNewChat);
  $("newchat-filter").addEventListener("input", paintPeople);
  $("newchat-form").addEventListener("submit", createChat);

  addEventListener("online", () => { if (me) subscribe(); });
  addEventListener("offline", () => setStatus("down"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && me && !$("screen-app").hidden) { catchUp(); markRead(); }
  });
  addEventListener("focus", () => { if (me && !$("screen-app").hidden) markRead(); });
}
