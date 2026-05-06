-- Cron automático para dropi-wallet-sync.
--
-- Antes de esta migration: el sync era 100% manual desde /logistica → Billetera.
-- Si pasaban días sin sync (ej. token Dropi vencido sin que nadie se enterara),
-- el wallet en /cfo y /logistica mostraba data vieja.
--
-- Frecuencia: cada 6 horas (00, 06, 12, 18 UTC). Justificación:
--   - 20-25 pedidos/día → ~50-70 movimientos wallet/día. No es high-frequency.
--   - Cada corrida descarga XLSX del rango (no es JSON liviano), por eso no
--     vamos a cada 1h o cada 5min como hace dropi-cron.
--   - 6h da 4 ventanas/día con margen para ver saldo actualizado durante la
--     jornada operativa sin mareo.
--
-- Auth: usa el patrón shared-secret (x-cron-secret) — ver migration
-- 20260417020000_cron_shared_secret.sql. La edge function dropi-wallet-sync
-- valida el header contra app_settings.cron_shared_secret y omite el getUser
-- (porque pg_cron no tiene user JWT).
--
-- Rango: últimas 48h (no los 30 días default). Razón: a esta frecuencia,
-- pedir 30d cada vez es desperdicio. 48h da margen para movimientos retroactivos
-- que Dropi puede backfilear 1-2 días después del evento real.
--
-- Idempotencia: la edge function ya hace UPSERT por dropi_transaction_id
-- (UNIQUE), así que correr 2 veces seguidas no duplica.

-- 1. Asegurar que el cron_shared_secret existe (para casos donde la migration
--    20260417020000 todavía no se aplicó por alguna razón).
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

-- 3. Schedule cada 6h. Body con últimas 48h.
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
      'from',   to_char((now() AT TIME ZONE 'UTC')::date - INTERVAL '2 days', 'YYYY-MM-DD'),
      'untill', to_char((now() AT TIME ZONE 'UTC')::date,                     'YYYY-MM-DD')
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);
