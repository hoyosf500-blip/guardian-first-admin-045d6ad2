SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('dropi-cron-every-5min') OR (command LIKE '%dropi-cron%' AND command NOT LIKE '%timeout_milliseconds%');

SELECT cron.schedule(
  'dropi-cron-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJva2hscGZtdHRvaXpqYWFrbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzgzNjksImV4cCI6MjA5MTYxNDM2OX0.tILkDzwZf8SSNKRDF9Neofd16MTwCOWqr2JcR-dMasc',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);