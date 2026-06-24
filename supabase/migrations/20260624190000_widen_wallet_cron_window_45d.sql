-- Ampliar la ventana del cron dropi-wallet-sync de 7 días → 45 días.
--
-- POR QUÉ (2026-06-24):
--   El wallet de Dropi PAGA CON RETRASO: una guía creada (y a veces entregada) en
--   un mes se cobra/abona en el wallet días o semanas después. Con la ventana de
--   7 días (migration 20260623140000), el cron de cada 6h NO alcanza los pagos que
--   Dropi liquida (o backfilea con fecha vieja) más de 7 días tarde → esos
--   movimientos nunca entran por el cron → la ganancia del mes queda SUBCONTADA
--   hasta que alguien corre el "Sincronizar" manual. 45 días cubre el ciclo de
--   pago COD completo (despacho → entrega → liquidación → abono), así el cron se
--   auto-cura solo, sin depender del botón manual.
--
-- COSTO: la data del wallet es chica (~7 movs/día/tienda → ~315 filas en 45d por
--   tienda). Descargar 45d de XLSX cada 6h sigue siendo liviano. El UPSERT por
--   dropi_transaction_id (UNIQUE) es idempotente: re-pedir filas ya sincronizadas
--   devuelve 0 cambios, no duplica. Para huecos > 45d sigue el "Sincronizar"
--   manual (rango configurable) en /logistica.
--
-- QUÉ NO CAMBIA respecto a 20260623140000: el schedule (cada 6h, '0 */6 * * *'),
--   el fan-out a las tiendas (body sin store_id), la auth (Bearer anon +
--   x-cron-secret) y el timeout. SOLO cambia el número de días de la ventana.
--
-- Idempotente: re-agenda (unschedule + schedule), igual que 20260623140000.
-- NO se auto-aplica (Lovable) → correr `supabase db push` o pegar en el SQL editor.

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

-- 3. Re-schedule cada 6h. Body con últimos 45 DÍAS (antes 7).
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
      'from',   to_char((now() AT TIME ZONE 'UTC')::date - INTERVAL '45 days', 'YYYY-MM-DD'),
      'untill', to_char((now() AT TIME ZONE 'UTC')::date,                      'YYYY-MM-DD')
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);
