-- Desfasar los schedules pg_cron que pegan a Dropi (anti-throttle 2026-07-07).
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-health%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-health-1h',
  '7 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-nightly-reconcile%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-nightly-reconcile',
  '17 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-nightly-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('dropi-wallet-sync-6h', 'dropi-wallet-sync')
        OR command ILIKE '%dropi-wallet-sync%'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-wallet-sync-6h',
  '23 */6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-wallet-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJva2hscGZtdHRvaXpqYWFrbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzgzNjksImV4cCI6MjA5MTYxNDM2OX0.tILkDzwZf8SSNKRDF9Neofd16MTwCOWqr2JcR-dMasc',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := jsonb_build_object(
      'from',   to_char((now() AT TIME ZONE 'UTC')::date - INTERVAL '45 days', 'YYYY-MM-DD'),
      'untill', to_char((now() AT TIME ZONE 'UTC')::date,                      'YYYY-MM-DD')
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);