-- Replace the pg_cron auth scheme with a shared secret.
-- Previous cron (20260415200923) sent the anon JWT as Bearer token, which the
-- edge function rejected because it is neither the service_role key nor a
-- valid user JWT with admin role. Result: the cron was scheduled but never
-- actually synced (Invoked=0 for 5 days).
--
-- New scheme:
--   1. Generate a random UUID, store in app_settings.cron_shared_secret
--   2. pg_cron sends x-cron-secret header; the edge function validates it
--      against the stored value and skips the admin-JWT path.
--   3. Authorization header still carries the project's anon key so the
--      Supabase API gateway lets the request through.

-- 1. Secret
INSERT INTO public.app_settings (key, value)
VALUES ('cron_shared_secret', gen_random_uuid()::text)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 2. Kill any previous dropi-cron schedules (wrong auth)
DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-cron%'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- 3. Schedule the new cron every 5 minutes.
SELECT cron.schedule(
  'dropi-cron-auto',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJva2hscGZtdHRvaXpqYWFrbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzgzNjksImV4cCI6MjA5MTYxNDM2OX0.tILkDzwZf8SSNKRDF9Neofd16MTwCOWqr2JcR-dMasc',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
