// Personal Chat -- public settings.
//
// Everything here ships to the browser and is safe to: the anon/publishable
// key only grants what row level security allows. NEVER put the
// secret (service-role) key in this file or anywhere in the repo (7.9); the
// deploy workflow refuses to publish if it finds one.

export const SUPABASE_URL = "https://thwuhxfrmktryzawtpff.supabase.co";

// Supabase dashboard -> Project Settings -> API Keys -> publishable (anon) key
export const SUPABASE_ANON_KEY = "sb_publishable_se8E2xQOUmNOxzXEksQmGA_eP_HsH22";

// 7.1: username "alice" signs in as auth email "alice@mychat.local".
// Must match USERNAME_EMAIL_DOMAIN in the Edge Functions (default the same).
export const USERNAME_EMAIL_DOMAIN = "mychat.local";

export const MAX_FILE_BYTES       = 50 * 1024 * 1024;   // FR-20
export const STORAGE_QUOTA_BYTES  = 1024 * 1024 * 1024; // free tier, for the admin gauge
export const IDLE_TIMEOUT_MINUTES = 30;                 // 7.6
export const SIGNED_URL_SECONDS   = 3600;               // FR-22
