-- ═══════════════════════════════════════════════════════════════════════════
-- Auditoría EC 2026-07-07 — 3 estados de Ecuador caían en bucket 'otros'.
--
-- Sondeado en vivo (tienda EC): "ASIGNADO A", "INGRESANDO" (pelado) y
-- "CLIENTE SOLICITA RETIRAR EN CS" quedaban sin bucket → entraban al total pero
-- desaparecían de en_transito/novedad. El embudo no cerraba (Σ buckets < total),
-- logistics_by_carrier diluía la tasa del carrier (columnas suman < total), y el
-- MISMO pedido se veía "En tránsito" en /seguimiento (segStatus.startsWith)
-- pero "sin clasificar" en el embudo de /logística. Los 3 son EC-transit/riesgo.
--
-- Fix espejo del cliente (src/lib/estadoBuckets.ts, mismo commit):
--   - LIKE 'ASIGNADO%'          → en_transito  (repartidor/carrier asignado)
--   - LIKE '%INGRESANDO%'       → en_transito  (cubre bare + "INGRESANDO A/OPERATIVO/DE RECOLECCION")
--   - LIKE '%SOLICITA RETIRAR%' → novedad      (cliente pide retirar = riesgo no-entrega)
--
-- Solo redefine _estado_bucket; todas las RPCs que la invocan
-- (logistics_summary/by_carrier/by_city/by_product/city_carrier, breakdown,
-- financial_summary, product_profitability, timeline, get_top_cities) toman el
-- cambio sin tocarlas. Idempotente (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

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
    -- fallbacks por contenido (ESTADO_FALLBACK_PATTERNS del cliente) — orden = terminales primero
    WHEN e LIKE 'DEVOLUC%'                    THEN 'devuelto'
    WHEN e LIKE 'ASIGNADO%'                   THEN 'en_transito'  -- NEW EC: "ASIGNADO A <carrier/ciudad>"
    WHEN e LIKE '%INGRESANDO%'                THEN 'en_transito'  -- NEW EC: bare + "INGRESANDO A/OPERATIVO/DE RECOLECCION"
    WHEN e LIKE '%BODEGA ORIGEN%'             THEN 'en_transito'
    WHEN e LIKE '%RUTA A%'                    THEN 'en_transito'
    WHEN e LIKE '%CENTRO LOGISTICO%'          THEN 'en_transito'
    WHEN e LIKE '%RECOLECCION%'               THEN 'en_transito'
    WHEN e LIKE '%DISTRIBUCION A CLIENTE%'    THEN 'en_transito'
    WHEN e LIKE '%DISTRIBUCION PARA ENTREGA%' THEN 'en_transito'
    WHEN e LIKE '%ZONA DE ENTREGA%'           THEN 'en_transito'
    WHEN e LIKE '%RETIRO EN AGENCIA%'         THEN 'novedad'
    WHEN e LIKE '%SOLICITA RETIRAR%'          THEN 'novedad'      -- NEW EC: "CLIENTE SOLICITA RETIRAR EN CS"
    WHEN e LIKE '%SOLUCION APROBADA%'         THEN 'novedad'
    ELSE 'otros'
  END
  FROM norm;
$$;

GRANT EXECUTE ON FUNCTION public._estado_bucket(text) TO authenticated;
