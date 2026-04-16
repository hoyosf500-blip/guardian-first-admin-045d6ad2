-- Schedule dropi-cron to run every 5 minutes.
--
-- Root-cause fix for the outage on 2026-04-15: the cron was originally
-- scheduled manually from the Supabase dashboard (or Lovable AI) and was
-- never tracked in a migration. When it went away (reset, cleanup, whatever)
-- there was nothing in version control to bring it back and the operators
-- silently stopped receiving new orders from Dropi for hours. This migration
-- makes the schedule reproducible: applying migrations always leaves the
-- cron programmed and pointing at the dropi-cron edge function.
--
-- The schedule POSTs to the edge function with a Bearer token pulled from
-- public.app_settings. The key 'dropi_service_role_fallback' must contain a
-- valid service_role JWT for this project — seed it manually (or via a
-- follow-up migration) before relying on this cron.

-- Idempotent: unschedule any previous dropi-cron job first so re-running
-- this migration (or applying it on top of a manually scheduled one)
-- does not leave duplicates.
DO $$
DECLARE
  existing_job RECORD;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-cron%'
  LOOP
    PERFORM cron.unschedule(existing_job.jobid);
  END LOOP;
END $$;

-- Schedule the new cron. URL is hardcoded because this project lives in a
-- single Supabase project (bokhlpfmttoizjaakntc) — no env substitution in
-- migrations. If the project ever moves, update this migration.
SELECT cron.schedule(
  'dropi-cron-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_settings WHERE key = 'dropi_service_role_fallback')
    ),
    body := '{}'::jsonb
  );
  $$
);
