-- lovable-cron-fallback-reviewed: 144 runs/day; la API de Chatea Pro no ofrece webhook de entrantes; 10 min es el retraso máximo aceptable para que una asesora vea a un cliente esperando respuesta.
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%chateapro-sync%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'chateapro-sync-10min',
  '7,17,27,37,47,57 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/chateapro-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);