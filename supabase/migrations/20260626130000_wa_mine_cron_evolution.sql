-- Re-agenda el cron diario de minería para incluir canales 'evolution' además de
-- 'whapi'. La función wa-mine-conversations ya es agnóstica: para no-whapi lee el
-- historial desde wa_messages (lo que pobló el webhook/inbox), sin tocar el gateway.
--
-- Necesario porque la migración 20260626120000 filtraba `provider = 'whapi'` y ya
-- fue aplicada (editarla no re-corre). Acá des-agendamos y re-agendamos.

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%wa-mine-conversations%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wa-mine-conversations-daily',
  '30 7 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/wa-mine-conversations',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJva2hscGZtdHRvaXpqYWFrbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzgzNjksImV4cCI6MjA5MTYxNDM2OX0.tILkDzwZf8SSNKRDF9Neofd16MTwCOWqr2JcR-dMasc',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := jsonb_build_object('store_id', s.store_id, 'days', 60, 'offset', 0)
  )
  FROM (SELECT DISTINCT store_id FROM public.wa_channels WHERE provider IN ('whapi', 'evolution')) s;
  $cron$
);
