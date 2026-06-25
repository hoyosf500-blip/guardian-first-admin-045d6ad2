-- Cron diario: el bot APRENDE SOLO, constantemente.
--
-- Cada día dispara wa-mine-conversations UNA VEZ POR TIENDA con canal whapi
-- (página más reciente, offset 0): baja las conversaciones nuevas, las analiza
-- con kie/Claude y actualiza el "conocimiento aprendido" por producto. En cuanto
-- un producto junta ≥2 conversaciones con dudas reales, escribe solo su bloque y
-- el bot lo usa. Sin tráfico, corre y no hace nada (barato).
--
-- Auth: anon Bearer (pasa el gateway) + x-cron-secret interno (== app_settings.
-- cron_shared_secret), MISMO esquema que wa-status-notifier / dropi-cron.
--
-- Horario 07:30 UTC ≈ 02:30 Bogotá: ventana de bajo tráfico, no compite con la
-- operación ni con el cron de avisos (cada 10 min).

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
  FROM (SELECT DISTINCT store_id FROM public.wa_channels WHERE provider = 'whapi') s;
  $cron$
);
