-- Cron de chateapro-sync — que Colombia deje de estar ciega (2026-09-02)
--
-- POR QUÉ. Medido ese mismo día sobre los 800 contactos de la cuenta de
-- Colombia: 39 clientes habían escrito y NADIE les había contestado. 36 hacía
-- más de 2 horas, 22 hacía más de un día y el más viejo hacía 97 horas. Entre
-- ellos una clienta con el pedido en NOVEDAD —la transportadora esperando
-- respuesta— que había escrito 28 horas antes.
--
-- Guardian no podía verlos. En la base, a la misma hora:
--     Ecuador    2.196 pedidos con chat_entrante_at   de 3.426
--     Colombia           0                            de   589
--     Colombia 2         0                            de    32
-- La bandeja «Escribieron» se alimenta de esa columna, así que mostraba
-- «Nadie esperando respuesta — todos los que escribieron ya fueron atendidos».
--
-- ⛔ ESTA MIGRACIÓN NO TOCA NINGUNA TABLA. Solo agenda un job. No hay DDL sobre
-- `orders` ni sobre ninguna tabla caliente, así que no aplica el riesgo de
-- REGLA #0 — las columnas de chat ya existían desde el sync de Ecuador.
--
-- ⛔ Idempotente y sin jobs duplicados: primero se DESENGANCHA cualquier cron
-- cuyo comando llame a chateapro-sync (por ILIKE, sin asumir el nombre) y
-- recién ahí se crea el canónico. Mismo patrón que el cron de importchat-sync.
--
-- CADENCIA: cada 10 minutos. Puede ser mucho más seguido que el de Ecuador
-- (30 min) porque acá no se descarga nada pesado: Chatea Pro devuelve
-- `last_message_at` y `last_message_type` en la propia lista de contactos, o
-- sea ~8 llamadas REST de 100 contactos por tienda. El de Ecuador baja un XLSX
-- de 48.000 filas y ~9 MB que ya lo mató dos veces por memoria; por eso allá la
-- frecuencia es un riesgo y acá no.
--
-- MINUTOS ELEGIDOS: :07,:17,:27,:37,:47,:57 — libres a propósito. Ocupados hoy:
-- dropi-cron (:00,:05…), importchat-sync (:12,:42), shopify-auto-push
-- (:03,:18,:33,:48), health (:00). Amontonar crons en el mismo minuto es lo que
-- ya disparó los 429 de Dropi.
--
-- AUTH: mismo esquema que el cron de importchat-sync, que está corriendo hoy
-- (x-cron-secret desde app_settings, sin Authorization). Si esta función
-- respondiera 401, mirar `cron.job_run_details` y en ese caso hay que
-- declararla en `supabase/config.toml` con verify_jwt = false — igual que
-- shopify-auto-push. No se hace por adelantado: sería abrirla sin necesidad.

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%chateapro-sync%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'chateapro-sync-10min',
  '7,17,27,37,47,57 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/chateapro-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    -- Sin store_id => todas las tiendas que tengan Chatea Pro configurado.
    -- La lista sale de `store_chateapro_config`, no de nombres escritos a mano:
    -- una tienda nueva entra sola el día que le carguen la llave.
    body := '{}'::jsonb
  );
  $$
);
