-- Personal Chat v1 -- schema, helper functions, RLS, storage.
-- Paste this whole file into the Supabase SQL Editor and run it.
-- Safe to run more than once.
--
-- Requirements: sections 7 and 8 of personal-chat-requirements.md.
-- Deliberate differences from the spec's SQL sketch are marked "NOTE:".

create extension if not exists pgcrypto with schema extensions;

-- ===========================================================================
-- 0. Retire the v0 shared-passcode tables
--
-- v0 had public.messages (sender/body/file_path) and public.device_state.
-- They are renamed, not dropped, so old history is kept, and every policy on
-- them is removed so no app user can read them. v0's storage policies let
-- any signed-in user read the whole bucket, so they go too.
-- ===========================================================================
do $$
declare p record;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'messages' and column_name = 'sender') then
    alter table public.messages rename to legacy_messages;
  end if;
  if to_regclass('public.device_state') is not null then
    alter table public.device_state rename to legacy_device_state;
  end if;

  for p in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('legacy_messages', 'legacy_device_state') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;

  if to_regclass('public.legacy_messages') is not null then
    alter table public.legacy_messages enable row level security;
    begin alter publication supabase_realtime drop table public.legacy_messages;
    exception when others then null; end;
  end if;
  if to_regclass('public.legacy_device_state') is not null then
    alter table public.legacy_device_state enable row level security;
    begin alter publication supabase_realtime drop table public.legacy_device_state;
    exception when others then null; end;
  end if;
end $$;

drop policy if exists "chat account reads files"   on storage.objects;
drop policy if exists "chat account uploads files" on storage.objects;
drop policy if exists "chat account deletes files" on storage.objects;
drop policy if exists "open read files"            on storage.objects;
drop policy if exists "open upload files"          on storage.objects;
drop policy if exists "open delete files"          on storage.objects;

-- ===========================================================================
-- 1. Tables (8.1)
--
-- NOTE: foreign keys that point at profiles use "on delete set null" (or
-- cascade) so the admin can actually delete a user. With the spec's plain
-- references, deleting anyone who ever sent a message or appears in the
-- audit log would fail. messages.sender_id is therefore nullable and shows
-- as "Deleted user".
-- ===========================================================================
create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  username             text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name         text check (char_length(display_name) <= 40),
  role                 text not null default 'member'  check (role in ('admin','member')),
  status               text not null default 'pending' check (status in ('pending','approved','disabled')),
  approved_by          uuid references public.profiles(id) on delete set null,
  approved_at          timestamptz,
  -- NOTE: not in the spec table; needed for 7.7 "must change on next login"
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now()
);

create table if not exists public.invite_codes (
  code        text primary key check (char_length(code) between 6 and 64),
  created_by  uuid references public.profiles(id) on delete set null,
  max_uses    int not null default 1 check (max_uses between 1 and 100),
  used_count  int not null default 0,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('self','direct','group')),
  name        text check (char_length(name) <= 60),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id         uuid references public.profiles(id) on delete cascade,
  last_read_at    timestamptz,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members (user_id);

create table if not exists public.files (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  uploader_id     uuid references public.profiles(id) on delete set null,
  storage_path    text not null unique,
  file_name       text not null check (char_length(file_name) <= 255),
  mime_type       text,
  size_bytes      bigint not null check (size_bytes <= 52428800), -- 50 MB
  -- FR-23: retention. Change the interval here to keep files longer/shorter.
  expires_at      timestamptz not null default now() + interval '30 days',
  created_at      timestamptz not null default now()
);
create index if not exists files_expires_idx on public.files (expires_at);

create table if not exists public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid references public.profiles(id) on delete set null,
  content         text check (char_length(content) <= 5000),
  file_id         uuid references public.files(id) on delete set null,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conv_id_idx      on public.messages (conversation_id, id desc);
create index if not exists messages_conv_created_idx on public.messages (conversation_id, created_at desc);

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  target_id   uuid,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);

-- 7.8: per-IP sign-up limit. Only the Edge Function (service role) touches it.
create table if not exists public.signup_attempts (
  id          bigint generated always as identity primary key,
  ip          text not null,
  created_at  timestamptz not null default now()
);
create index if not exists signup_attempts_ip_idx on public.signup_attempts (ip, created_at);

-- ===========================================================================
-- 2. Helper functions (8.2)
-- ===========================================================================

-- NOTE: stricter than the spec. If the user has a verified 2FA factor, the
-- session must be aal2, so a stolen password alone gets no data (7.7).
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and status = 'approved')
     and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
          or not exists (select 1 from auth.mfa_factors
                         where user_id = auth.uid() and status = 'verified'));
$$;

-- Admin actions always need a 2FA-verified session (7.7, checklist item 10).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     and exists (select 1 from public.profiles
                 where id = auth.uid() and status = 'approved' and role = 'admin');
$$;

create or replace function public.is_member(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_approved() and exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id = auth.uid());
$$;

-- First folder of a storage path as a uuid, or null if it isn't one. A bare
-- ::uuid cast would throw on any odd path and break the whole query.
create or replace function public.path_conversation(path text) returns uuid
language sql immutable as $$
  select case when split_part(path, '/', 1)
                   ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(path, '/', 1)::uuid end;
$$;

-- Internal: write an audit row as the current user. Not callable by clients.
create or replace function public.audit(p_action text, p_target uuid default null, p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (actor_id, action, target_id, details)
  values (auth.uid(), p_action, p_target, p_details);
$$;

-- Internal: the user's "My Devices" conversation, created on first call.
create or replace function public.ensure_self_conversation(p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select c.id into cid
    from public.conversations c
    join public.conversation_members m on m.conversation_id = c.id
   where c.type = 'self' and m.user_id = p_user
   limit 1;
  if cid is null then
    insert into public.conversations (type, name, created_by)
    values ('self', 'My Devices', p_user) returning id into cid;
    insert into public.conversation_members (conversation_id, user_id, last_read_at)
    values (cid, p_user, now());
  end if;
  return cid;
end $$;

-- ===========================================================================
-- 3. Triggers
-- ===========================================================================

-- A new auth user gets a pending profile. The Edge Function passes the
-- username in user_metadata; a user created by hand in the dashboard as
-- "name@mychat.local" gets "name".
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare uname text := lower(coalesce(new.raw_user_meta_data ->> 'username',
                                     split_part(new.email, '@', 1)));
begin
  if uname ~ '^[a-z0-9_]{3,20}$' then
    insert into public.profiles (id, username, display_name)
    values (new.id, uname, coalesce(new.raw_user_meta_data ->> 'display_name', uname))
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Members may change only their display name. role / status / username and
-- the approval columns are admin-only. Server-side code (SQL editor, service
-- role -- no auth.uid()) and the trusted RPCs below are exempt.
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and coalesce(current_setting('app.trusted', true), '') <> 'on'
     and not public.is_admin() then
    if new.id                   is distinct from old.id
    or new.username             is distinct from old.username
    or new.role                 is distinct from old.role
    or new.status               is distinct from old.status
    or new.approved_by          is distinct from old.approved_by
    or new.approved_at          is distinct from old.approved_at
    or new.must_change_password is distinct from old.must_change_password
    or new.created_at           is distinct from old.created_at then
      raise exception 'You can only change your display name.' using errcode = '42501';
    end if;
  end if;

  -- An admin can't lock themselves out by accident.
  if auth.uid() = old.id and old.role = 'admin'
     and (new.role <> 'admin' or new.status <> 'approved') then
    raise exception 'You cannot demote or disable your own admin account.' using errcode = '42501';
  end if;

  if new.status = 'approved' and old.status <> 'approved' then
    new.approved_at := now();
    new.approved_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists protect_profile on public.profiles;
create trigger protect_profile before update on public.profiles
  for each row execute function public.protect_profile();

create or replace function public.after_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and old.status <> 'approved' then
    perform public.ensure_self_conversation(new.id);       -- FR-12
    perform public.audit(case when old.status = 'disabled' then 'user_enabled' else 'user_approved' end,
                         new.id, jsonb_build_object('username', new.username));
  elsif new.status = 'disabled' and old.status <> 'disabled' then
    perform public.audit('user_disabled', new.id, jsonb_build_object('username', new.username));
  end if;
  if new.role is distinct from old.role then
    perform public.audit('role_changed', new.id,
                         jsonb_build_object('username', new.username, 'from', old.role, 'to', new.role));
  end if;
  return null;
end $$;

drop trigger if exists after_profile_update on public.profiles;
create trigger after_profile_update after update on public.profiles
  for each row execute function public.after_profile_update();

-- FR-17: messages are never edited, only soft-deleted. Content and the file
-- link are cleared at the database, not just hidden in the UI.
create or replace function public.guard_message_update() returns trigger
language plpgsql as $$
begin
  -- Foreign-key "set null" housekeeping (file expired, sender deleted).
  if new.content         is not distinct from old.content
     and new.conversation_id = old.conversation_id
     and new.created_at      = old.created_at
     and new.deleted_at      is not distinct from old.deleted_at
     and (new.file_id   is not distinct from old.file_id   or new.file_id   is null)
     and (new.sender_id is not distinct from old.sender_id or new.sender_id is null) then
    return new;
  end if;

  if old.deleted_at is not null or new.deleted_at is null then
    raise exception 'Messages can only be deleted, not edited.' using errcode = '42501';
  end if;

  new.id              := old.id;
  new.conversation_id := old.conversation_id;
  new.sender_id       := old.sender_id;
  new.created_at      := old.created_at;
  new.content         := null;
  new.file_id         := null;
  new.deleted_at      := now();
  return new;
end $$;

drop trigger if exists guard_message_update on public.messages;
create trigger guard_message_update before update on public.messages
  for each row execute function public.guard_message_update();

create or replace function public.audit_invite() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.audit('invite_created', null,
    jsonb_build_object('code', new.code, 'max_uses', new.max_uses, 'expires_at', new.expires_at));
  return null;
end $$;

drop trigger if exists audit_invite on public.invite_codes;
create trigger audit_invite after insert on public.invite_codes
  for each row execute function public.audit_invite();

create or replace function public.audit_file_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.audit(case when old.expires_at <= now() then 'file_expired' else 'file_deleted' end,
    old.id, jsonb_build_object('file_name', old.file_name, 'size_bytes', old.size_bytes,
                               'conversation_id', old.conversation_id));
  return null;
end $$;

drop trigger if exists audit_file_delete on public.files;
create trigger audit_file_delete after delete on public.files
  for each row execute function public.audit_file_delete();

-- ===========================================================================
-- 4. RPCs the app calls
-- ===========================================================================

-- Sidebar: my conversations with title, unread count and last activity.
create or replace function public.conversation_list()
returns table (id uuid, type text, title text, peer_id uuid, member_count int,
               last_message_at timestamptz, last_read_at timestamptz, unread int)
language sql stable security definer set search_path = public as $$
  select c.id, c.type,
         case c.type when 'self'   then 'My Devices'
                     when 'direct' then coalesce(pp.display_name, pp.username, 'Deleted user')
                     else coalesce(c.name, 'Group') end,
         peer.user_id,
         (select count(*)::int from public.conversation_members x where x.conversation_id = c.id),
         (select max(mm.created_at) from public.messages mm where mm.conversation_id = c.id),
         me.last_read_at,
         (select count(*)::int from public.messages mm
           where mm.conversation_id = c.id and mm.deleted_at is null
             and mm.sender_id is distinct from auth.uid()
             and mm.created_at > coalesce(me.last_read_at, '-infinity'))
    from public.conversation_members me
    join public.conversations c on c.id = me.conversation_id
    left join lateral (select x.user_id from public.conversation_members x
                        where x.conversation_id = c.id and x.user_id <> auth.uid()
                        limit 1) peer on c.type = 'direct'
    left join public.profiles pp on pp.id = peer.user_id
   where me.user_id = auth.uid() and public.is_approved()
   order by 6 desc nulls last;
$$;

-- FR-13 / FR-14. A direct chat with someone you already have one with
-- returns the existing conversation instead of a duplicate.
create or replace function public.create_conversation(p_type text, p_name text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare
  cid    uuid;
  others uuid[];
begin
  if not public.is_approved() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  others := array(select distinct u from unnest(p_members) u where u is not null and u <> auth.uid());
  if exists (select 1 from unnest(others) u
              where not exists (select 1 from public.profiles p where p.id = u and p.status = 'approved')) then
    raise exception 'Everyone in a chat must be an approved user.';
  end if;

  if p_type = 'direct' then
    if coalesce(array_length(others, 1), 0) <> 1 then
      raise exception 'A direct chat needs exactly one other person.';
    end if;
    select c.id into cid from public.conversations c
     where c.type = 'direct'
       and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = auth.uid())
       and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = others[1]);
    if cid is not null then return cid; end if;
  elsif p_type = 'group' then
    if coalesce(array_length(others, 1), 0) < 1 then
      raise exception 'Pick at least one person for the group.';
    end if;
    if coalesce(btrim(p_name), '') = '' then
      raise exception 'A group needs a name.';
    end if;
  else
    raise exception 'Unknown conversation type.';
  end if;

  insert into public.conversations (type, name, created_by)
  values (p_type, case when p_type = 'group' then left(btrim(p_name), 60) end, auth.uid())
  returning id into cid;

  insert into public.conversation_members (conversation_id, user_id)
  select cid, u from unnest(others) u;
  insert into public.conversation_members (conversation_id, user_id, last_read_at)
  values (cid, auth.uid(), now());
  return cid;
end $$;

create or replace function public.mark_read(p_conv uuid) returns void
language sql security definer set search_path = public as $$
  update public.conversation_members set last_read_at = now()
   where conversation_id = p_conv and user_id = auth.uid() and public.is_approved();
$$;

create or replace function public.log_login() returns void
language sql security definer set search_path = public as $$
  select public.audit('login', auth.uid(), null) where auth.uid() is not null;
$$;

-- FR-7: change password needs the current one. Checked here so the app
-- doesn't have to sign in again (which would drop a 2FA session to aal1).
create or replace function public.check_password(p_password text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from auth.users u
                  where u.id = auth.uid()
                    and u.encrypted_password = extensions.crypt(p_password, u.encrypted_password));
$$;

-- Clears the "must change password" flag after an admin reset.
create or replace function public.password_changed() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.trusted', 'on', true);
  update public.profiles set must_change_password = false where id = auth.uid();
  perform public.audit('password_changed', auth.uid(), null);
end $$;

-- FR-24: storage used across the project (the free-tier quota is global).
create or replace function public.storage_usage()
returns table (bytes bigint, file_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only.' using errcode = '42501';
  end if;
  return query
    select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint, count(*)::bigint
      from storage.objects o;
end $$;

-- Keep-alive target for the GitHub Action (section 10). Touches nothing.
create or replace function public.ping() returns text
language sql stable as $$ select 'ok'::text $$;

-- Service-role-only helpers for the sign-up Edge Function. Atomic, so two
-- sign-ups can't both take the last use of a code.
create or replace function public.consume_invite(p_code text) returns boolean
language sql security definer set search_path = public as $$
  with u as (
    update public.invite_codes set used_count = used_count + 1
     where code = p_code and used_count < max_uses and expires_at > now()
    returning 1)
  select exists (select 1 from u);
$$;

create or replace function public.refund_invite(p_code text) returns void
language sql security definer set search_path = public as $$
  update public.invite_codes set used_count = greatest(used_count - 1, 0) where code = p_code;
$$;

-- ===========================================================================
-- 5. Privileges
--
-- Nothing in public is reachable without signing in, apart from ping().
-- RLS would already return nothing; this makes anon get a hard "permission
-- denied" instead (checklist item 3).
-- ===========================================================================
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon, public;

grant execute on function public.ping() to anon, authenticated;
grant execute on function
  public.is_approved(), public.is_admin(), public.is_member(uuid), public.path_conversation(text),
  public.conversation_list(), public.create_conversation(text, text, uuid[]), public.mark_read(uuid),
  public.log_login(), public.check_password(text), public.password_changed(), public.storage_usage()
  to authenticated;

-- Internal only: never callable from the browser.
revoke execute on function
  public.audit(text, uuid, jsonb), public.ensure_self_conversation(uuid),
  public.consume_invite(text), public.refund_invite(text)
  from authenticated;
grant execute on function public.consume_invite(text), public.refund_invite(text) to service_role;

-- Trigger functions run as their owner; nobody needs to call them directly.
revoke execute on function
  public.handle_new_user(), public.protect_profile(), public.after_profile_update(),
  public.guard_message_update(), public.audit_invite(), public.audit_file_delete()
  from authenticated;

-- ===========================================================================
-- 6. Row level security (8.3)
-- ===========================================================================
alter table public.profiles             enable row level security;
alter table public.invite_codes         enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.files                enable row level security;
alter table public.messages             enable row level security;
alter table public.audit_log            enable row level security;
alter table public.signup_attempts      enable row level security;   -- no policies: service role only

-- Profiles
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "read approved"    on public.profiles;
drop policy if exists "admin read all"   on public.profiles;
drop policy if exists "admin update"     on public.profiles;
drop policy if exists "update own name"  on public.profiles;
create policy "read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "read approved"    on public.profiles for select to authenticated using (public.is_approved() and status = 'approved');
create policy "admin read all"   on public.profiles for select to authenticated using (public.is_admin());
create policy "admin update"     on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- role/status changes are blocked by the protect_profile trigger
create policy "update own name"  on public.profiles for update to authenticated
  using (id = auth.uid() and public.is_approved()) with check (id = auth.uid());

-- Messages
drop policy if exists "members read"   on public.messages;
drop policy if exists "members send"   on public.messages;
drop policy if exists "sender deletes" on public.messages;
create policy "members read"   on public.messages for select to authenticated using (public.is_member(conversation_id));
create policy "members send"   on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and deleted_at is null and public.is_member(conversation_id)
              and (file_id is null or exists (select 1 from public.files f
                                               where f.id = file_id and f.conversation_id = messages.conversation_id)));
-- the guard_message_update trigger turns any update into a soft delete
create policy "sender deletes" on public.messages for update to authenticated
  using (sender_id = auth.uid() and public.is_member(conversation_id))
  with check (sender_id = auth.uid());

-- Conversations and membership (created only through create_conversation)
drop policy if exists "members read conv"    on public.conversations;
drop policy if exists "read own memberships" on public.conversation_members;
create policy "members read conv"    on public.conversations        for select to authenticated using (public.is_member(id));
create policy "read own memberships" on public.conversation_members for select to authenticated using (public.is_member(conversation_id));

-- File metadata
drop policy if exists "members read files"   on public.files;
drop policy if exists "members add files"    on public.files;
drop policy if exists "uploader removes file" on public.files;
create policy "members read files" on public.files for select to authenticated using (public.is_member(conversation_id));
create policy "members add files"  on public.files for insert to authenticated
  with check (uploader_id = auth.uid() and public.is_member(conversation_id)
              and public.path_conversation(storage_path) = conversation_id);
create policy "uploader removes file" on public.files for delete to authenticated
  using ((uploader_id = auth.uid() and public.is_member(conversation_id)) or public.is_admin());

-- Invite codes and audit log: admin only
drop policy if exists "admin invites" on public.invite_codes;
drop policy if exists "admin audit"   on public.audit_log;
create policy "admin invites" on public.invite_codes for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin audit"   on public.audit_log   for select to authenticated using (public.is_admin());

-- ===========================================================================
-- 7. Storage (7.5 / 8.4): private bucket, 50 MB, members of the folder only
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "members upload"            on storage.objects;
drop policy if exists "members download"          on storage.objects;
drop policy if exists "uploader or admin deletes" on storage.objects;

create policy "members upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.is_member(public.path_conversation(name)));

create policy "members download" on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.is_member(public.path_conversation(name)));

create policy "uploader or admin deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-files'
         and ((owner_id = auth.uid()::text and public.is_member(public.path_conversation(name)))
              or public.is_admin()));

-- ===========================================================================
-- 8. Realtime (FR-15). RLS applies to every event, so users only hear
--    about rows they could select anyway.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['messages', 'conversation_members', 'profiles'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
