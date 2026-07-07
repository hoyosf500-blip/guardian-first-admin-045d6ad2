-- Migration 1: 20260707160000_estado_bucket_ec_states.sql
CREATE OR REPLACE FUNCTION public._estado_bucket(p_estado text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  WITH norm AS (
    SELECT btrim(translate(
      regexp_replace(replace(upper(coalesce(p_estado, '')), '_', ' '), '\s+', ' ', 'g'),
      'ÁÉÍÓÚÜÑ', 'AEIOUUN'
    )) AS e
  )
  SELECT CASE
    WHEN e IN ('REEMPLAZADA', 'ARCHIVADO GHOST') THEN 'borrado'
    WHEN e LIKE '%CANCEL%' THEN 'cancelado'
    WHEN e IN ('ENTREGADO', 'ENTREGADO A DESTINO') THEN 'entregado'
    WHEN e IN ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'DEVOLUCION A ORIGEN')
      OR e LIKE 'DEVUELT%' THEN 'devuelto'
    WHEN e = 'RECHAZADO' THEN 'rechazado'
    WHEN e IN ('PENDIENTE', 'PENDIENTE CONFIRMACION') THEN 'pendiente'
    WHEN e IN ('NOVEDAD', 'INTENTO DE ENTREGA', 'NOVEDAD SOLUCIONADA', 'REPROGRAMADO',
               'RECLAME EN OFICINA', 'EN PROCESO DE INDEMNIZACION', 'INDEMNIZADA') THEN 'novedad'
    WHEN e IN ('CONFIRMADO', 'GENERADO', 'GUIA GENERADA', 'PREPARANDO', 'PREPARANDO PARA ENVIO',
               'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA', 'EN PROCESAMIENTO',
               'PROCESANDO', 'ALISTAMIENTO', 'EN ALISTAMIENTO', 'EN BODEGA DROPI',
               'RECOGIDO POR DROPI', 'POR RECOLECTAR') THEN 'preparacion'
    WHEN e IN ('EN TRANSITO', 'EN CAMINO', 'EN BODEGA', 'EN TRANSPORTE', 'EN DESPACHO',
               'EN TRASLADO NACIONAL', 'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO', 'EN REPARTO',
               'EN DISTRIBUCION', 'EN REEXPEDICION', 'TELEMERCADEO', 'REENVIO',
               'EN BODEGA TRANSPORTADORA', 'ADMITIDA', 'DESPACHADA', 'EN BODEGA DESTINO',
               'EN PUNTO DROOP') THEN 'en_transito'
    WHEN e LIKE 'DEVOLUC%'                    THEN 'devuelto'
    WHEN e LIKE 'ASIGNADO%'                   THEN 'en_transito'
    WHEN e LIKE '%INGRESANDO%'                THEN 'en_transito'
    WHEN e LIKE '%BODEGA ORIGEN%'             THEN 'en_transito'
    WHEN e LIKE '%RUTA A%'                    THEN 'en_transito'
    WHEN e LIKE '%CENTRO LOGISTICO%'          THEN 'en_transito'
    WHEN e LIKE '%RECOLECCION%'               THEN 'en_transito'
    WHEN e LIKE '%DISTRIBUCION A CLIENTE%'    THEN 'en_transito'
    WHEN e LIKE '%DISTRIBUCION PARA ENTREGA%' THEN 'en_transito'
    WHEN e LIKE '%ZONA DE ENTREGA%'           THEN 'en_transito'
    WHEN e LIKE '%RETIRO EN AGENCIA%'         THEN 'novedad'
    WHEN e LIKE '%SOLICITA RETIRAR%'          THEN 'novedad'
    WHEN e LIKE '%SOLUCION APROBADA%'         THEN 'novedad'
    ELSE 'otros'
  END
  FROM norm;
$$;

GRANT EXECUTE ON FUNCTION public._estado_bucket(text) TO authenticated;

-- Migration 2: 20260707170000_schedule_health_and_nightly.sql
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