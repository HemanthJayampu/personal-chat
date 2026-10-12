-- Personal Chat v1 -- background jobs (section 10).
-- Run AFTER deploying the cleanup-files Edge Function (see README, step 4).
-- Safe to run more than once.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Vault secrets. The cleanup secret is generated here, inside Postgres, and
-- checked here (cleanup_secret_ok), so it never has to be copied anywhere.
-- Change project_url if you use this with a different Supabase project.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://thwuhxfrmktryzawtpff.supabase.co', 'project_url',
                                'Base URL used by pg_cron to call Edge Functions');
  end if;
  if not exists (select 1 from vault.secrets where name = 'cleanup_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cleanup_secret',
                                'Shared secret between pg_cron and the cleanup-files Edge Function');
  end if;
end $$;

-- Called by the cleanup-files Edge Function (service role only).
create or replace function public.cleanup_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = public as $$
  select length(coalesce(p_secret, '')) >= 32
     and exists (select 1 from vault.decrypted_secrets
                  where name = 'cleanup_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.cleanup_secret_ok(text) from public, anon, authenticated;
grant  execute on function public.cleanup_secret_ok(text) to service_role;

-- Daily: delete expired files through the Storage API (never by deleting
-- rows in storage.objects directly).
select cron.unschedule(jobid) from cron.job where jobname = 'cleanup-files';
select cron.schedule('cleanup-files', '15 3 * * *', $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/cleanup-files',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cleanup-secret',
                 (select decrypted_secret from vault.decrypted_secrets where name = 'cleanup_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);

-- Daily: forget sign-up attempts older than a day (they only matter for an hour).
select cron.unschedule(jobid) from cron.job where jobname = 'prune-signup-attempts';
select cron.schedule('prune-signup-attempts', '30 3 * * *', $job$
  delete from public.signup_attempts where created_at < now() - interval '1 day';
$job$);
