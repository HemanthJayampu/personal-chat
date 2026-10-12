// Entry point: wire up the screens, then let the router pick one.
import { sb } from "./supabase.js";
import { initAuth } from "./auth.js";
import { initSettings } from "./settings.js";
import { initAdmin } from "./admin.js";
import { route } from "./session.js";

initAuth();
initSettings();
initAdmin();

// Signed out elsewhere: "log out all devices", a revoked refresh token, or
// another tab. Show the login screen here too.
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") setTimeout(route, 0);
});

route();

// PWA (Phase 5): offline app shell and notification clicks.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker:", err));
  });
}
