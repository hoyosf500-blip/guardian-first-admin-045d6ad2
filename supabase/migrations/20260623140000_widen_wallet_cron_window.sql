-- Ampliar la ventana del cron dropi-wallet-sync de 48h → 7 días.
--
-- DIAGNÓSTICO (2026-06-23, datos en vivo de sync_logs + cron.job):
--   El cron `dropi-wallet-sync-6h` está ACTIVO, fanea a las 2 tiendas y corre
--   cada 6h con status=success — PERO synced_count=0 en cada corrida. La causa:
--   el body pedía solo las últimas 48h. Si el wallet quedó atrasado (downtime, o
--   movimientos que Dropi BACKFILEA con fecha vieja >48h), la ventana de 48h
--   NUNCA los alcanza → sincroniza 0 para siempre → max(synced_at) se congela →
--   el badge marca "stale" aunque el cron "corra OK". Es el estado zombie.
--   Prueba: el sync manual de 30d sí trajo el backlog (209 movs en CO), el cron
--   de 48h no.
--
-- FIX: ventana de 7 días. La data del wallet es chica (~7 movs/día/tienda → ~50
--   filas en 7d), así que descargar 7d de XLSX cada 6h sigue siendo liviano, y
--   ahora se auto-cura hasta una semana de atraso o de backfill retroactivo de
--   Dropi. El UPSERT por dropi_transaction_id (UNIQUE) es idempotente: re-pedir
--   filas ya sincronizadas devuelve 0 cambios, no duplica.
--   Para huecos > 7d sigue estando el "Sincronizar" manual (rango 30d) en /logistica.
--
-- Idempotente: re-agenda (unschedule + schedule), igual que la migration
-- original 20260506140000_dropi_wallet_sync_cron.sql.

-- 1. Asegurar que el cron_shared_secret existe (defensivo).
INSERT INTO public.app_settings (key, value)
VALUES ('cron_shared_secret', gen_random_uuid()::text)
ON CONFLICT (key) DO NOTHING;

-- 2. Killear cualquier schedule previo de wallet sync (idempotencia).
DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('dropi-wallet-sync-6h', 'dropi-wallet-sync')
        OR command ILIKE '%dropi-wallet-sync%'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- 3. Re-schedule cada 6h. Body con últimos 7 DÍAS (antes 48h).
SELECT cron.schedule(
  'dropi-wallet-sync-6h',
  '0 */6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-wallet-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJva2hscGZtdHRvaXpqYWFrbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzgzNjksImV4cCI6MjA5MTYxNDM2OX0.tILkDzwZf8SSNKRDF9Neofd16MTwCOWqr2JcR-dMasc',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := jsonb_build_object(
      'from',   to_char((now() AT TIME ZONE 'UTC')::date - INTERVAL '7 days', 'YYYY-MM-DD'),
      'untill', to_char((now() AT TIME ZONE 'UTC')::date,                     'YYYY-MM-DD')
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);
