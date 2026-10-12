import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY, USERNAME_EMAIL_DOMAIN } from "../config.js";

// Sessions persist in localStorage (the supabase-js default, 7.6). Access
// tokens last about an hour and refresh automatically.
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// 7.1: usernames map onto internal, undeliverable auth emails.
export const usernameToEmail = (u) => `${u.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// FR-3. Same rule as the Edge Function.
export function passwordProblem(pw) {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 72) return "Password must be at most 72 characters.";
  if (!/[a-z]/i.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}

// Call an Edge Function and surface its { error } message, not the generic
// "Edge Function returned a non-2xx status code".
export async function callFunction(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try {
      const j = await error.context.json();
      if (j?.error) msg = j.error;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return data;
}
