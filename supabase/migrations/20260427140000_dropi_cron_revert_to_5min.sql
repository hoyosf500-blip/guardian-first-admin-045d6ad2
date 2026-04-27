-- Revertir cron de Dropi de 1 min a 5 min.
--
-- Por qué: con el cron corriendo cada 1 min, cada minuto entraba una
-- ráfaga de upserts a `orders`. Eso disparaba realtime en el frontend
-- y la lista de Seguimiento/Rescate se reordenaba bajo el cursor de la
-- operadora — la pantalla parpadeaba y le hacía perder el sitio justo
-- cuando iba a hacer click. Reportado en producción 2026-04-27.
--
-- Con 5 min volvemos al comportamiento original (commit e631ffa,
-- 17-abr): lag máximo Dropi → panel ~5 min, parpadeo eliminado.
-- Trade-off aceptado por la admin: prefiere lag de 5 min antes que
-- perder trabajo de las operadoras por reorder constante.

-- Idempotente: limpia cualquier job previo de dropi-cron (1min o 5min).
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

-- Reagenda con intervalo de 5 minutos (mismo header auth que la
-- versión 1-min para no romper la edge function).
SELECT cron.schedule(
  'dropi-cron-5min',
  '*/5 * * * *',
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
