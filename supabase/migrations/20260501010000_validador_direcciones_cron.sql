-- pg_cron jobs para validador de direcciones.
-- Idempotente: unschedule previo + schedule, mismo patrón que
-- 20260427110000_dropi_cron_1min_fix.sql

-- Reset diario de cuota a las 00:00 Bogotá (== 05:00 UTC)
DO $cron$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reset-google-quota-daily') THEN
    PERFORM cron.unschedule('reset-google-quota-daily');
  END IF;
END $cron$;

SELECT cron.schedule(
  'reset-google-quota-daily',
  '0 5 * * *',
  $$
    UPDATE public.app_settings SET value = '0.00' WHERE key = 'google_api_used_today_usd';
    UPDATE public.app_settings SET value = to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD')
      WHERE key = 'google_api_used_today_date';
  $$
);

-- Cleanup de cache expirado a las 02:00 Bogotá (== 07:00 UTC)
DO $cron$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-autocomplete-cache-daily') THEN
    PERFORM cron.unschedule('cleanup-autocomplete-cache-daily');
  END IF;
END $cron$;

SELECT cron.schedule(
  'cleanup-autocomplete-cache-daily',
  '0 7 * * *',
  $$ SELECT public.cleanup_expired_autocomplete_cache(); $$
);
