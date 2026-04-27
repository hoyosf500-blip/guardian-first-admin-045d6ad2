DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dropi-cron-1min') THEN
    PERFORM cron.unschedule('dropi-cron-1min');
  END IF;
END $$;

SELECT cron.schedule(
  'dropi-cron-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
