# Personal Chat & File Transfer App — Requirements and Plan

**Owner:** Project owner
**Version:** 1.0 (draft)
**Date:** 12 Oct 2026
**Budget:** ₹0 / $0, with no credit card required anywhere

---

## 1. Purpose

A private, Teams-like web app to send messages, links and files between my own devices (laptop, office PC, phone) and a small number of approved people. It must be available 24/7 without me running a server, and only approved users can get in.

## 2. Goals and non-goals

**Goals**
- Send text and files (up to 50 MB each) between devices and approved users in real time
- Works on Windows, Mac, Android and iPhone through the browser, installable as a PWA
- Secure sign-up and login with username and password, and admin approval for new users
- Zero cost and zero server maintenance

**Non-goals (v1)**
- Voice or video calls
- Large files (over 50 MB). Use Tailscale + LocalSend or Syncthing for those.
- Public access or open registration
- End-to-end encryption (possible in v2, see section 12)

## 3. Technology stack

| Layer | Choice | Cost | Card needed? |
|---|---|---|---|
| Frontend hosting | GitHub Pages (or Cloudflare Pages) | Free | No |
| Frontend | HTML + JavaScript (Vite + vanilla JS or React), PWA | Free | — |
| Backend | Supabase free tier: Postgres, Auth, Realtime, Storage, Edge Functions | Free | No |
| Client library | `@supabase/supabase-js` | Free | — |
| 2FA app | Google Authenticator / Microsoft Authenticator | Free | — |

**Free-tier limits to plan around** (check the current values on supabase.com/pricing when you sign up, because they change):
- File storage: about 1 GB in total. Deleting files frees space immediately.
- Database: about 500 MB, which is plenty for text messages.
- Per-file upload limit: about 50 MB
- The project **pauses after about 7 days of no activity** and can be resumed with one click from the dashboard.
- Some session controls (inactivity timeout, time-boxed sessions) are paid features, so they are implemented in the app instead (see 7.6).

## 4. Users and roles

| Role | Can do |
|---|---|
| **Admin** (project owner) | Everything a member can, plus approve, reject, disable and delete users, create invite codes, and view the audit log |
| **Member** (approved) | Chat, send and receive files, manage own profile and 2FA |
| **Pending** | Log in and see a "Waiting for approval" screen only. No data access. |
| **Disabled** | Cannot access anything |

## 5. Functional requirements

### 5.1 Authentication
- FR-1: Sign up with **username + password + invite code**.
- FR-2: Username rules: 3–20 characters, lowercase letters, numbers and underscore, unique.
- FR-3: Password rules: at least 10 characters, containing letters and numbers.
- FR-4: New accounts are created with `status = pending`.
- FR-5: Log in with username + password, then a 2FA code if 2FA is enabled. 2FA is **mandatory for admin**.
- FR-6: Log out, and "log out of all devices".
- FR-7: Change password (requires the current password).

### 5.2 Admin
- FR-8: Admin screen lists pending users with Approve / Reject.
- FR-9: Admin can disable, re-enable or delete any user.
- FR-10: Admin can create invite codes (single-use or multi-use, with an expiry date).
- FR-11: Admin can view the audit log (sign-ups, approvals, logins, deletions).

### 5.3 Chat
- FR-12: A "My Devices" conversation per user, acting as a personal notes/transfer space visible from all their logged-in devices.
- FR-13: Direct conversation between two approved users.
- FR-14: Optional group conversations.
- FR-15: Real-time message delivery, with no page refresh needed.
- FR-16: Message history persists and loads older messages on scroll.
- FR-17: Delete your own message (soft delete; an attached file is removed from storage).
- FR-18: Clickable links, and copy-to-clipboard for messages.

### 5.4 Files
- FR-19: Upload by file picker, drag and drop, or paste (for screenshots).
- FR-20: Max 50 MB per file, checked in the app **before** upload.
- FR-21: Upload progress bar, plus image thumbnail preview.
- FR-22: Download through a **signed URL** valid for 1 hour.
- FR-23: Files are **auto-deleted after 30 days** (configurable).
- FR-24: Storage usage indicator (for example "620 MB / 1 GB used") on the admin screen.

### 5.5 Notifications
- FR-25: In-app unread badges per conversation.
- FR-26: Browser notifications when the tab is in the background (v1). Push notifications to closed apps come in v2.

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Available 24/7 (apart from the free-tier pause after 7 inactive days) |
| NFR-2 | Messages delivered in under 2 seconds |
| NFR-3 | Works on the latest Chrome, Edge, Safari and Firefox, on desktop and mobile |
| NFR-4 | HTTPS only. GitHub Pages and Supabase both provide this. |
| NFR-5 | No secret keys in frontend code |
| NFR-6 | Database backup exported weekly (free tier has no automatic backups) |

## 7. Security design

### 7.1 Username-based login on Supabase Auth
Supabase Auth is email-based. The app maps a username to an internal email address:

```
username "alice"  →  auth email "alice@mychat.local"
```

- In Supabase → Authentication → Providers → Email: **turn off "Confirm email"**, because these addresses can't receive mail.
- The real username is stored in `profiles.username`.
- Passwords are hashed by Supabase (bcrypt). The app never stores or logs them.
- **Trade-off:** there is no "forgot password" by email. The admin resets passwords instead (see 7.7).

### 7.2 Invite code (blocks random sign-ups)
- Sign-up goes through a Supabase **Edge Function** `signup-with-invite`:
  1. Validate the invite code (exists, not expired, uses remaining).
  2. Validate the username format and that it is unique.
  3. Create the user with the admin API (server-side only).
  4. Create the profile with `status = pending`, and increment `used_count`.
- **Disable public sign-ups** in Supabase settings, so the Edge Function is the only way to create an account.

### 7.3 Admin approval (the main gate)
- Even with a valid invite code, a new user stays **pending** until the admin approves.
- A pending user's session has no access to any data, enforced by RLS rather than just the UI.

### 7.4 Row Level Security (RLS)
RLS is enabled on **every** table. This is the real security layer, because anything in the browser can be bypassed.
- A user can read a conversation and its messages only if they are an **approved member** of it.
- A user can only insert messages as themselves, into conversations they belong to.
- Only the admin can change another user's `status` or `role`.
- Realtime subscriptions also respect RLS, so users only receive messages they are allowed to see.

### 7.5 File storage security
- The bucket `chat-files` is **private**.
- Path format: `{conversation_id}/{uuid}_{filename}`
- Storage policies allow upload and download only if the user is an approved member of that `conversation_id`.
- Files are served only through **signed URLs (1 hour expiry)**, so a forwarded link stops working.
- The allowed size (50 MB) is enforced in the bucket settings as well as in the app.

### 7.6 Sessions
- Supabase issues short-lived access tokens (about 1 hour), refreshed automatically.
- **App-side idle timeout:** log out after 30 minutes of inactivity.
- "Log out all devices" calls `signOut({ scope: 'global' })`.
- Sessions are stored in browser local storage (the supabase-js default). Avoid using the app on shared or public computers.

### 7.7 Two-factor authentication (TOTP)
- Uses Supabase's built-in MFA (free): the user scans a QR code with an authenticator app.
- **Mandatory for admin**, optional for members.
- RLS on sensitive tables can require `aal2` (2FA-verified session) for admin actions.
- Password reset: the admin triggers a reset through an Edge Function and shares a temporary password, which the user must change on next login.

### 7.8 Brute-force protection
- Supabase Auth has built-in rate limits on login and sign-up.
- The sign-up Edge Function adds its own limit: max 5 attempts per IP per hour.

### 7.9 Key handling — rules
| Key | Where it lives |
|---|---|
| `anon` (public) key | Frontend. Safe because RLS protects the data. |
| `service_role` key | **Only** inside Edge Function secrets. Never in the frontend, never in GitHub. |

### 7.10 Audit log
These events are recorded in `audit_log`: sign-up, approval or rejection, login, failed login (where available), user disabled or deleted, invite created, and file deleted.

## 8. Database design

### 8.1 Tables

```sql
-- User profile (1:1 with auth.users)
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name  text,
  role          text not null default 'member' check (role in ('admin','member')),
  status        text not null default 'pending' check (status in ('pending','approved','disabled')),
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table invite_codes (
  code        text primary key,
  created_by  uuid references profiles(id),
  max_uses    int not null default 1,
  used_count  int not null default 0,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create table conversations (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('self','direct','group')),
  name        text,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create table conversation_members (
  conversation_id uuid references conversations(id) on delete cascade,
  user_id         uuid references profiles(id) on delete cascade,
  last_read_at    timestamptz,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table files (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  uploader_id     uuid references profiles(id),
  storage_path    text not null unique,
  file_name       text not null,
  mime_type       text,
  size_bytes      bigint not null check (size_bytes <= 52428800), -- 50 MB
  expires_at      timestamptz not null default now() + interval '30 days',
  created_at      timestamptz not null default now()
);

create table messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid not null references profiles(id),
  content         text check (char_length(content) <= 5000),
  file_id         uuid references files(id) on delete set null,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index on messages (conversation_id, created_at desc);

create table audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references profiles(id),
  action      text not null,
  target_id   uuid,
  details     jsonb,
  created_at  timestamptz not null default now()
);
```

### 8.2 Helper functions

```sql
-- Is the current user approved?
create function is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles
                 where id = auth.uid() and status = 'approved');
$$;

-- Is the current user an approved admin?
create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles
                 where id = auth.uid() and status = 'approved' and role = 'admin');
$$;

-- Is the current user an approved member of a conversation?
create function is_member(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_approved() and exists (
    select 1 from conversation_members
    where conversation_id = conv and user_id = auth.uid());
$$;
```

### 8.3 RLS policies (core examples)

```sql
alter table profiles             enable row level security;
alter table invite_codes         enable row level security;
alter table conversations        enable row level security;
alter table conversation_members enable row level security;
alter table files                enable row level security;
alter table messages             enable row level security;
alter table audit_log            enable row level security;

-- Profiles: everyone sees their own row; approved users see other approved users; admin sees all
create policy "read own profile"  on profiles for select using (id = auth.uid());
create policy "read approved"     on profiles for select using (is_approved() and status = 'approved');
create policy "admin read all"    on profiles for select using (is_admin());
create policy "admin update"      on profiles for update using (is_admin());
create policy "update own name"   on profiles for update using (id = auth.uid())
  with check (id = auth.uid());   -- block role/status changes via a trigger or column privileges

-- Messages
create policy "members read"   on messages for select using (is_member(conversation_id));
create policy "members send"   on messages for insert
  with check (sender_id = auth.uid() and is_member(conversation_id));
create policy "sender deletes" on messages for update using (sender_id = auth.uid());

-- Conversations and membership
create policy "members read conv" on conversations for select using (is_member(id));
create policy "read own memberships" on conversation_members for select
  using (is_member(conversation_id));

-- Files metadata
create policy "members read files" on files for select using (is_member(conversation_id));
create policy "members add files"  on files for insert
  with check (uploader_id = auth.uid() and is_member(conversation_id));

-- Invite codes and audit log: admin only
create policy "admin invites" on invite_codes for all using (is_admin());
create policy "admin audit"   on audit_log   for select using (is_admin());
```

> **Important:** stop members changing their own `role` or `status`. Do this with a `before update` trigger that rejects changes to those columns unless `is_admin()`, or by revoking update on those columns from the `authenticated` role.

### 8.4 Storage policies (bucket `chat-files`, private)

```sql
create policy "members upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files'
              and is_member(((storage.foldername(name))[1])::uuid));

create policy "members download" on storage.objects for select to authenticated
  using (bucket_id = 'chat-files'
         and is_member(((storage.foldername(name))[1])::uuid));
```

## 9. Screens

| # | Screen | Key elements |
|---|---|---|
| 1 | Login | Username, password, then a 2FA code step if enabled |
| 2 | Sign up | Username, password, confirm password, invite code |
| 3 | Pending approval | Message plus a logout button |
| 4 | Chat home | Sidebar (My Devices, direct chats, groups, unread badges); message pane; input with attach button |
| 5 | New chat | Pick approved users and create a direct chat or group |
| 6 | Settings | Display name, change password, set up 2FA (QR code), log out all devices |
| 7 | Admin | Pending users (approve/reject), all users (disable/delete/reset password), invite codes, storage usage, audit log |

## 10. Background jobs

| Job | Schedule | How |
|---|---|---|
| Delete expired files | Daily | `pg_cron` calls the Edge Function `cleanup-files` (through `pg_net`), which deletes expired objects via the **Storage API** and then deletes the `files` rows. Never delete rows in `storage.objects` directly with SQL. |
| Keep-alive (optional) | Every 3 days | A scheduled GitHub Action (free) pings the API to avoid the 7-day inactivity pause |
| DB backup | Weekly | Manual `pg_dump` / Supabase CLI export to your laptop (or a GitHub Action to a private repo) |

## 11. Build plan

### Phase 1: Setup (Week 1)
- [ ] Create a Supabase account (GitHub login, no card) and a new project in the Singapore region
- [ ] Create a GitHub repo and enable GitHub Pages
- [ ] Turn off email confirmation and public sign-ups in Supabase Auth
- [ ] Run the table, function and RLS SQL from section 8
- [ ] Create the private `chat-files` bucket with a 50 MB limit and the storage policies
- [ ] Create your own admin account manually and set `role='admin', status='approved'`

### Phase 2: Auth and admin (Week 2)
- [ ] Edge Function `signup-with-invite`
- [ ] Login, sign-up and pending screens
- [ ] Admin screen: approve/reject, disable/delete, invite codes
- [ ] 2FA enrolment and verification (make it mandatory for admin)
- [ ] Idle timeout and "log out all devices"

### Phase 3: Chat (Week 3)
- [ ] Conversation list, plus an auto-created "My Devices" chat on approval
- [ ] Send and receive messages with Supabase Realtime
- [ ] History with pagination, unread badges, soft delete

### Phase 4: Files (Week 4)
- [ ] Upload (picker, drag and drop, paste) with size check and progress bar
- [ ] Signed-URL download and image preview
- [ ] Cleanup Edge Function plus `pg_cron` schedule
- [ ] Storage usage on the admin screen

### Phase 5: PWA and hardening (Week 5)
- [ ] `manifest.json`, service worker, app icons, so it installs on phone and desktop
- [ ] Browser notifications
- [ ] Keep-alive GitHub Action and a backup routine
- [ ] Run the security test checklist (section 13)

## 12. Future enhancements (v2)
- End-to-end encryption: encrypt files in the browser before upload so Supabase only ever stores ciphertext
- Web push notifications when the app is closed
- Message search
- "Send to device" shortcut from the Windows / Android share menu (PWA share target)
- Large-file fallback through peer-to-peer WebRTC (no storage used)

## 13. Security test checklist

- [ ] Sign-up without an invite code fails
- [ ] Sign-up with an expired or used-up code fails
- [ ] A pending user cannot read profiles, messages or files, even through direct API calls using the anon key
- [ ] User A cannot read User B's conversation by guessing its ID
- [ ] A member cannot set their own `role` to admin or `status` to approved
- [ ] A disabled user loses access immediately
- [ ] A signed file URL stops working after 1 hour
- [ ] A file over 50 MB is rejected
- [ ] The `service_role` key is not in the frontend bundle or the Git history
- [ ] Admin actions fail without a 2FA-verified session
- [ ] Repeated wrong passwords get rate-limited

## 14. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Project pauses after 7 inactive days | App down until resumed | Keep-alive GitHub Action; resume with one click |
| Storage fills up (1 GB) | Uploads fail | 30-day auto-delete; usage indicator; manual cleanup |
| Free-tier terms change | Limits or features may shrink | Keep the code portable (plain Postgres + standard JS); weekly backups |
| No email password recovery | Locked-out user | Admin reset flow; keep admin 2FA recovery codes safe |
| Supabase can technically read stored files | Privacy | Don't store highly sensitive files in v1; add E2E encryption in v2 |
| Lost admin 2FA device | Admin locked out | Save the TOTP secret or recovery codes offline; second admin factor |
