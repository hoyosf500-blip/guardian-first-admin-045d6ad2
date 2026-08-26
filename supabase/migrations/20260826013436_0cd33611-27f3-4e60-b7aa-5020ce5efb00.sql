-- Versionar el cron de importchat-sync (2026-08-25)
--
-- El cron que dispara importchat-sync (trae lo que el cliente nos escribe)
-- EXISTE en la base pero se creó A MANO — no estaba en el repo, así que si se
-- borra, el inbound deja de entrar y nadie se entera hasta que los clientes no
-- reciben respuesta. Esta migración lo oficializa.
--
-- ⛔ REGLA #1 (no pisar lo desplegado): NO se asume el nombre del job manual. Se
-- DESENGANCHA cualquier cron cuyo comando llame a importchat-sync (por ILIKE) y
-- recién ahí se crea el canónico. Así no quedan DOS jobs corriendo en paralelo
-- (doble descarga del XLSX de 9MB = doble carga y más chance de OOM). Mismo patrón
-- idempotente que usa shopify_auto_push.
--
-- Auth = x-cron-secret (app_settings.cron_shared_secret), igual que
-- dropi-cron / dropi-health / shopify-auto-push. Sin store_id => procesa TODAS las
-- tiendas (importchat-sync/index.ts:373).
--
-- Cadencia: cada 30 min (:12 y :42), offset para no chocar con dropi-cron
-- (:00/:05…), health (:00) ni shopify-auto-push (:03/:18/:33/:48). Se DEJA en 30
-- min a propósito: subir la frecuencia baja la latencia del inbound pero duplica
-- la descarga del XLSX completo por tienda, que ya murió por memoria varias veces.
-- La latencia real se resuelve con webhook (pendiente), no con más polling.

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%importchat-sync%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'importchat-sync-30min',
  '12,42 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/importchat-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);