# Personal Chat

A private, Teams-like web app for sending messages, links and files (up to 50 MB) between your own devices and a few approved people. It is a static site on GitHub Pages with a Supabase free-tier backend, so it costs nothing and needs no card.

The full requirements are in [personal-chat-requirements.md](personal-chat-requirements.md). Requirement IDs such as FR-12 and section numbers such as 7.4 are referenced in code comments.

## What's where

| Path | What it is |
|---|---|
| `index.html`, `style.css`, `js/`, `config.js` | The app: plain ES modules with no build step |
| `manifest.json`, `sw.js`, `icons/` | PWA: install to the Home Screen or desktop, offline shell, notification clicks |
| `supabase/migrations/0001_schema.sql` | Tables, helper functions, triggers, RLS, storage bucket and policies, realtime |
| `supabase/migrations/0002_cron.sql` | Daily file cleanup through `pg_cron` and `pg_net` |
| `supabase/bootstrap-admin.sql` | Makes your first account the admin |
| `supabase/functions/signup-with-invite` | The only way to sign up: checks the invite code, applies the per-IP limit, creates a pending user |
| `supabase/functions/admin-users` | Admin delete/reject and password reset. These need the service role. |
| `supabase/functions/cleanup-files` | Deletes expired files through the Storage API |
| `.github/workflows/pages.yml` | Deploys the site to GitHub Pages, and fails if it finds a secret key |
| `.github/workflows/keep-alive.yml` | Pings Supabase every 3 days so the project doesn't pause |
| `scripts/backup.sh` | Weekly `pg_dump` to your laptop |
| `scripts/security-check.mjs` | Runs the automated part of the section 13 checklist |

## Setup

### 1. Supabase project
1. Use your existing project, or sign in at supabase.com with GitHub (no card needed) and create a new one in the Singapore region.
2. Go to **Authentication → Sign In / Providers**:
   - Turn **off** "Allow new users to sign up". The Edge Function is now the only way to create an account.
   - Under **Email**, turn **off** "Confirm email", because `@mychat.local` addresses can't receive mail.
   - Leave "Secure password change" **off**. It sends an email, which can't arrive.
3. Go to **Authentication → Multi-Factor**. Make sure TOTP is enabled (it is by default).

### 2. Database
Open **SQL Editor**, paste the whole of `supabase/migrations/0001_schema.sql`, and run it.

> **Coming from the old passcode version?** The script renames the old `messages` and `device_state` tables to `legacy_messages` and `legacy_device_state`. Their history is kept, but app users can't read them any more. The old open storage policies are removed. Files uploaded by the old version stay in the `chat-files` bucket, but nobody can reach them. You can delete them under **Storage** when you're ready. The old shared login has no profile, so it can't see any data. Delete it under **Authentication → Users**.

### 3. Edge Functions
Homebrew isn't needed; the official CLI runs through `npx` (Node 18+). Log in once (it opens your browser):

```bash
npx -y supabase@2.120.0 login
```

Then deploy, from this folder:

```bash
for f in signup-with-invite admin-users cleanup-files; do npx -y supabase@2.120.0 functions deploy "$f" --project-ref thwuhxfrmktryzawtpff --no-verify-jwt --use-api; done
```

`--no-verify-jwt` is intentional. Each function does its own checks (an invite code, an admin with an aal2 session, or the cleanup secret). The gateway's JWT check would also reject the new `sb_publishable_` keys. `--use-api` bundles on Supabase's side, so Docker isn't needed.

Once the site is on GitHub Pages, lock browser calls to it:

```bash
npx -y supabase@2.120.0 secrets set ALLOWED_ORIGIN=https://<your-github-username>.github.io --project-ref thwuhxfrmktryzawtpff
```

### 4. Daily cleanup job
Run `supabase/migrations/0002_cron.sql` in the SQL Editor. It stores the project URL in Vault, **generates the cleanup secret inside Postgres** (it never leaves the database, and the function checks it there), and schedules the jobs. To test it straight away, run the `net.http_post(...)` call from the job by hand, then `select status_code, content from net._http_response order by id desc limit 1;` should show `200 {"ok":true,...}`.

### 5. Your admin account
1. Go to **Authentication → Users → Add user → Create new user**. Use email `<your-username>@mychat.local` (pick any username: 3–20 lowercase letters, numbers or `_`), a password of at least 10 characters with letters and numbers, and tick **Auto Confirm User**.
2. Put your username into `supabase/bootstrap-admin.sql` and run it.
3. Open the app and sign in with that username. It makes you set up 2FA first, because 2FA is mandatory for the admin. **Save the secret it shows somewhere offline.** Supabase TOTP has no recovery codes, so that secret is your way back in if you lose your phone. You can also add a second authenticator from Settings.

### 6. GitHub Pages
1. Create a repo, push this folder to `main`, and set **Settings → Pages → Source** to **GitHub Actions**. `pages.yml` publishes only the site files.
2. For the keep-alive job, go to **Settings → Secrets and variables → Actions → Variables** and add `SUPABASE_URL` and `SUPABASE_ANON_KEY`, using the same values as in `config.js`.
3. Go to **Supabase → Authentication → URL Configuration** and set the Site URL to your Pages URL.

### 7. Invite people
In the app, go to **Admin → Invites**, create a code and send it to the person. After they sign up, approve them under **Admin → Pending**.

## Running locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Service workers and the clipboard work on `localhost` without HTTPS.

## How the main requirements are met

| Requirement | Where |
|---|---|
| Username login (7.1) | `js/supabase.js` `usernameToEmail`, `config.js` `USERNAME_EMAIL_DOMAIN` |
| Invite-only sign-up, 5 per IP per hour (7.2, 7.8) | `signup-with-invite`, atomic `consume_invite()` |
| Admin approval enforced by RLS (7.3, 7.4) | `is_approved()` / `is_member()` in every policy |
| Members can't change their own role or status | `protect_profile` trigger |
| 2FA mandatory for admin; admin actions need aal2 (7.7) | `is_admin()` checks `aal2`; `js/session.js` forces enrolment |
| A password alone isn't enough once 2FA is on | `is_approved()` requires aal2 if the user has a verified factor |
| Private bucket, `{conversation_id}/{uuid}_{name}`, 1-hour signed URLs (7.5) | Storage policies, `js/files.js` |
| 50 MB checked before upload, and by the bucket (FR-20) | `sizeProblem()`, `files.size_bytes` check, bucket limit |
| Upload progress (FR-21) | XHR upload in `js/files.js` |
| Soft delete removes the file (FR-17) | `guard_message_update` trigger, `deleteFile()` |
| 30-day auto-delete (FR-23) | `files.expires_at`, `cleanup-files`, `0002_cron.sql` |
| My Devices chat on approval (FR-12) | `after_profile_update` trigger, `ensure_self_conversation()` |
| Unread badges, read ticks (FR-25) | `conversation_list()`, `mark_read()`, `last_read_at` |
| Idle timeout 30 min, log out all devices (7.6, FR-6) | `js/session.js`, Settings |
| Audit log (7.10) | Triggers, Edge Functions, `log_login()` |

To keep files for a different length of time, change `interval '30 days'` in `0001_schema.sql` and run `alter table public.files alter column expires_at set default now() + interval '60 days';`.

### Differences from the spec's SQL sketch
- **Deleting users works.** Foreign keys to `profiles` use `on delete set null`, so a removed user's old messages show as "Deleted user". Otherwise deleting anyone who had ever sent a message would fail.
- **`profiles.must_change_password`** has been added for the admin password-reset flow (7.7).
- **The `signup_attempts` table** has been added for the per-IP limit (7.8).
- **The `anon` role has no table access at all.** The only exception is `ping()` for the keep-alive job.
- **No Vite build.** Plain ES modules deploy straight to Pages, with nothing to install or update. `supabase-js` is pinned to version 2.57.4 from esm.sh, and the service worker caches it.
- **Failed logins are not in the app's audit log.** Supabase doesn't expose them to the database. You can see them in **Supabase → Logs → Auth**.

## Security testing (section 13)

```bash
node scripts/security-check.mjs
```

For the signed-in checks, create two throwaway users: one left pending, and one approved member without 2FA. Then run:

```bash
PENDING_USER=test_pending PENDING_PASS='...' MEMBER_USER=test_member MEMBER_PASS='...' node scripts/security-check.mjs
```

The script lists the checks you still need to do by hand, such as signed-URL expiry, rate limiting and the 50 MB rejection.

## Maintenance
- **Backups (weekly):** set `SUPABASE_DB_URL`, then run `./scripts/backup.sh`. Details are at the top of the script.
- **Deploying a frontend change:** bump `VERSION` in `sw.js` so installed apps pick up the new files.
- **If the project paused anyway:** resume it from the Supabase dashboard with one click.
