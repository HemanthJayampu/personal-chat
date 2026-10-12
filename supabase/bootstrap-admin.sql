-- Personal Chat -- make the first admin (Phase 1, last step).
--
-- 1. Supabase dashboard -> Authentication -> Users -> Add user -> Create new user
--      Email:    <your-username>@mychat.local
--      Password: at least 10 characters with letters and numbers
--      Tick "Auto Confirm User".
--    The on_auth_user_created trigger gives it a pending profile named <your-username>.
-- 2. Replace your_username below with your username, then run this file.
-- 3. Sign in to the app. It will make you set up 2FA before anything else.

update public.profiles
   set role = 'admin', status = 'approved'
 where username = 'your_username';

select username, role, status, approved_at from public.profiles where role = 'admin';
