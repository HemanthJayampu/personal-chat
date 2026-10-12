import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

// ALLOWED_ORIGIN is a comma-separated list of the sites allowed to call these
// functions from a browser, e.g.
//   https://you.github.io,http://personalchat.localhost:8765
// Unset means any site (the functions still do their own auth checks).
const ALLOWED = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((o) => o.trim()).filter(Boolean);

const corsBase = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function allowOrigin(req: Request): string {
  if (ALLOWED.includes("*")) return "*";
  const origin = req.headers.get("Origin") ?? "";
  return ALLOWED.includes(origin) ? origin : ALLOWED[0];
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsBase, "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsBase });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  return null;
}

// Deno.serve plus the per-request Access-Control-Allow-Origin header.
export function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    const res = await handler(req);
    res.headers.set("Access-Control-Allow-Origin", allowOrigin(req));
    return res;
  });
}

// The service_role key only ever exists here, as an Edge Function secret
// that Supabase injects. Never in the frontend, never in Git (7.9).
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// A client that acts as whoever called the function, so RLS and
// is_admin() see the caller's own JWT (including its aal level).
export function callerClient(req: Request): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim()
    || req.headers.get("x-real-ip")
    || "unknown";
}

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const EMAIL_DOMAIN = Deno.env.get("USERNAME_EMAIL_DOMAIN") ?? "mychat.local";

// FR-3: at least 10 characters, with letters and numbers.
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 72) return "Password must be at most 72 characters.";
  if (!/[a-z]/i.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}
