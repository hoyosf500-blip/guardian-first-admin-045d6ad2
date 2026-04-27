-- Reduce el intervalo del cron de Dropi de 5 min a 1 min.
--
-- Antes: dropi-cron-5min corre cada 5 minutos. Lag máx Dropi → panel = ~5 min.
-- Después: dropi-cron-1min corre cada minuto. Lag máx ~1 min.
--
-- Combinado con el realtime de Supabase (~500ms DB → frontend), el panel
-- queda actualizado dentro de 1 min de cualquier cambio en Dropi.
--
-- Trade-off: 5x más llamadas a la API de Dropi. Si la cuenta tiene rate
-- limit ajustado, monitorear logs los primeros días tras el deploy.

-- Idempotente: limpiar cualquier job previo del cron de Dropi.
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

-- Reagenda con intervalo de 1 minuto.
SELECT cron.schedule(
  'dropi-cron-1min',
  '* * * * *',
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
