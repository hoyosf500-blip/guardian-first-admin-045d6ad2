-- Agenda dropi-health (cada hora) y dropi-nightly-reconcile (3am UTC).
--
-- Auditoría EC 2026-07-07: ninguna de las dos funciones tenía migration de
-- cron.schedule en el repo. Si el schedule manual se cae o nunca se recreó tras
-- un reset del proyecto, (a) last_health_status de store_dropi_config queda
-- congelado y DropiParityPanel muestra un estado viejo sin alerta, y (b) la
-- defensa anti-zombie/huérfanos del nightly (cancelar fantasmas, reconciliar
-- divergencias) deja de correr en silencio. Idempotentes: mismo patrón
-- unschedule-by-command-ILIKE + cron.schedule que 20260427140000_dropi_cron.
-- Auth = x-cron-secret (app_settings.cron_shared_secret), igual que dropi-cron.

-- ── dropi-health: cada hora en el minuto 0 ──────────────────────────────────
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-health%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-health-1h',
  '0 * * * *',
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

-- ── dropi-nightly-reconcile: 3:00 AM UTC ────────────────────────────────────
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-nightly-reconcile%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-nightly-reconcile',
  '0 3 * * *',
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
