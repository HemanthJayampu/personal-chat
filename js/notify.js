// FR-26: browser notifications while the tab is in the background.

export const notificationsSupported = () => "Notification" in window;

export function notificationState() {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;   // "default" | "granted" | "denied"
}

export async function requestNotifications() {
  if (!notificationsSupported()) return "unsupported";
  return Notification.requestPermission();
}

export async function notify(title, body, tag) {
  if (notificationState() !== "granted") return;
  const opts = { body, tag, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { tag } };
  // Android Chrome only allows notifications through the service worker.
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts);
  } catch { /* fall back */ }
  try { new Notification(title, opts); } catch { /* not allowed here */ }
}

export function setAppBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge?.(n);
    else navigator.clearAppBadge?.();
  } catch { /* unsupported */ }
}
