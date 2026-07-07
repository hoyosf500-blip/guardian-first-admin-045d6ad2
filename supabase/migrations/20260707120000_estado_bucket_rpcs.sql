-- ═══════════════════════════════════════════════════════════════════════════
-- Auditoría KPIs 2026-07-07 — una sola fuente de verdad para buckets de estado.
--
-- Problemas que arregla (todos verificados en vivo contra la DB):
--  1. REEMPLAZADA (orden vieja de cada edición, soft-borrada en Dropi) contaba
--     en TODOS los totales/denominadores server-side: los filtros eran
--     `<> 'CANCELADO'` / `NOT LIKE '%CANCEL%'` y no la atrapaban. Ej. real:
--     julio EC summary total 231 = 264 − 33 cancelados (las 3 REEMPLAZADA
--     adentro); GINTRACOM "3 pedidos, 0% entrega" donde 2 eran fantasmas.
--  2. product_profitability ROTA en runtime: 42702 `column "devueltos" is
--     ambiguous` — `SUM(devueltos)` sin calificar choca con la columna OUT.
--  3. Estados EC (EN TRÁNSITO con tilde, ZONA DE ENTREGA, EN CAMINO, INGRESANDO
--     DE RECOLECCION A..., etc.) invisibles para los buckets del server:
--     en_transito=0 con ~48 pedidos en la calle (60/231 sin bucket).
--  4. "Entregado" con dos criterios opuestos: financial_summary LIKE 'ENTREGAD%'
--     (contaba 'ENTREGADO A TRANSPORTADORA' = preparación) vs '=ENTREGADO'
--     exacto en el resto (perdía 'ENTREGADO A DESTINO' de EC).
--  5. Rechazos: server los suma dentro de `devueltos` pero la tasa madura del
--     Resumen los excluye (decisión dueño 2026-06-24). Ahora cada RPC devuelve
--     `rechazados` aparte para que el cliente calcule la madura consistente;
--     `devueltos` SIGUE incluyendo rechazos (la vista de plata no cambia).
--  6. Filtro global de ciudad: logistics_by_product / orders_estado_breakdown /
--     logistics_timeline no aceptaban p_ciudad y lo ignoraban en silencio.
--  7. Billetera de socios: la tabla de movimientos era RLS admin-only (los
--     agregados SÍ salían por RPC) → policy de SELECT para owner/supervisor.
--
-- Diseño: public._estado_bucket(text) espeja resolveBucket() de
-- src/lib/estadoBuckets.ts (lookup exacto sin acentos + fallbacks por
-- contenido). Si se agrega un estado nuevo, actualizar AMBOS lados.
-- ASIMETRÍA DELIBERADA: en SQL 'REEMPLAZADA'/'ARCHIVADO GHOST' → bucket
-- 'borrado' (para EXCLUIRLAS de todo); el cliente las mapea a 'cancelado'
-- porque solo las ve por la RPC vieja o por realtime — al aplicar esta
-- migration el server ya no se las manda.
-- Los cuerpos base vienen de las copias APLICADAS por Lovable (20260626225713 y
-- 20260707050637) — no del repo viejo — para no pisar drift.
-- Los CTEs que computan el bucket son MATERIALIZED: garantiza UNA evaluación
-- de _estado_bucket por fila (la función tiene WITH/FROM y no se inlinea).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._estado_bucket(p_estado text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  WITH norm AS (
    -- upper + '_'→' ' + colapsar espacios + trim FINAL + sin acentos
    -- (espejo de normalizeEstado + stripAccents de estadoBuckets.ts; el btrim
    -- va al final para que un '_' al borde no deje espacio residual).
    SELECT btrim(translate(
      regexp_replace(replace(upper(coalesce(p_estado, '')), '_', ' '), '\s+', ' ', 'g'),
      'ÁÉÍÓÚÜÑ', 'AEIOUUN'
    )) AS e
  )
  SELECT CASE
    -- borrado: soft-delete de Guardian/Dropi — NO existe para ninguna métrica
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
    -- fallbacks por contenido (ESTADO_FALLBACK_PATTERNS) — solo si el exacto falló
    WHEN e LIKE 'DEVOLUC%'                    THEN 'devuelto'   -- variantes nuevas de Dropi (baseline financial_summary)
    WHEN e LIKE '%BODEGA ORIGEN%'             THEN 'en_transito'
    WHEN e LIKE '%RUTA A%'                    THEN 'en_transito'
    WHEN e LIKE '%CENTRO LOGISTICO%'          THEN 'en_transito'
    WHEN e LIKE '%RECOLECCION%'               THEN 'en_transito'
    WHEN e LIKE '%INGRESANDO OPERATIVO%'      THEN 'en_transito'
    WHEN e LIKE '%INGRESANDO A%'              THEN 'en_transito'
    WHEN e LIKE '%DISTRIBUCION A CLIENTE%'    THEN 'en_transito'
    WHEN e LIKE '%DISTRIBUCION PARA ENTREGA%' THEN 'en_transito'
    WHEN e LIKE '%ZONA DE ENTREGA%'           THEN 'en_transito'
    WHEN e LIKE '%RETIRO EN AGENCIA%'         THEN 'novedad'
    WHEN e LIKE '%SOLUCION APROBADA%'         THEN 'novedad'
    ELSE 'otros'
  END
  FROM norm;
$$;

GRANT EXECUTE ON FUNCTION public._estado_bucket(text) TO authenticated;

-- Normalizador expuesto aparte (misma expresión que _estado_bucket) para los
-- conteos que necesitan distinguir DENTRO de un bucket (ej. PENDIENTE vs
-- PENDIENTE CONFIRMACION) sin duplicar la fórmula.
CREATE OR REPLACE FUNCTION public._estado_norm(p_estado text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT btrim(translate(
    regexp_replace(replace(upper(coalesce(p_estado, '')), '_', ' '), '\s+', ' ', 'g'),
    'ÁÉÍÓÚÜÑ', 'AEIOUUN'
  ));
$$;

GRANT EXECUTE ON FUNCTION public._estado_norm(text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_summary(date, date) — overload legacy (sin p_ciudad)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_summary(p_from_date date, p_to_date date)
 RETURNS TABLE(total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT o.valor, public._estado_bucket(o.estado) AS b
    FROM public.orders o
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND o.store_id = v_store
  ),
  base AS (
    SELECT * FROM raw WHERE b NOT IN ('cancelado', 'borrado')
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE b = 'entregado'),
    COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')),
    COUNT(*) FILTER (WHERE b = 'en_transito'),
    ROUND((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    ROUND((COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    COALESCE(SUM(valor) FILTER (WHERE b = 'entregado'), 0),
    COALESCE(SUM(valor) FILTER (WHERE b IN ('devuelto', 'rechazado')), 0)
  FROM base;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_summary(date, date, text) — la que usa el cliente.
-- Cambia el RETURNS TABLE (+rechazados, +valor_rechazado) → DROP primero.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_summary(date, date, text);

CREATE FUNCTION public.logistics_summary(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, valor_en_transito numeric, pendientes_sin_despachar bigint, pendientes_por_confirmar bigint, valor_pendientes numeric, cancelados bigint, valor_cancelado numeric, novedades bigint, valor_novedades numeric, rechazados bigint, valor_rechazado numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    -- e_norm y b comparten normalización (_estado_norm / _estado_bucket) para
    -- que el conteo de pendientes y su valor no puedan divergir.
    SELECT o.valor, public._estado_bucket(o.estado) AS b, public._estado_norm(o.estado) AS e_norm
    FROM public.orders o
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_ciudad IS NULL OR ciudad = p_ciudad)
      AND o.store_id = v_store
  ),
  all_orders AS (
    SELECT * FROM raw WHERE b <> 'borrado'
  )
  SELECT
    COUNT(*) FILTER (WHERE b <> 'cancelado'),
    COUNT(*) FILTER (WHERE b = 'entregado'),
    COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')),
    COUNT(*) FILTER (WHERE b = 'en_transito'),
    ROUND((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric * 100.0 / NULLIF(COUNT(*) FILTER (WHERE b <> 'cancelado'), 0), 2),
    ROUND((COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')))::numeric * 100.0 / NULLIF(COUNT(*) FILTER (WHERE b <> 'cancelado'), 0), 2),
    COALESCE(SUM(all_orders.valor) FILTER (WHERE b = 'entregado'), 0),
    COALESCE(SUM(all_orders.valor) FILTER (WHERE b IN ('devuelto', 'rechazado')), 0),
    COALESCE(SUM(all_orders.valor) FILTER (WHERE b = 'en_transito'), 0),
    COUNT(*) FILTER (WHERE e_norm = 'PENDIENTE'),
    COUNT(*) FILTER (WHERE e_norm = 'PENDIENTE CONFIRMACION'),
    COALESCE(SUM(all_orders.valor) FILTER (WHERE b = 'pendiente'), 0),
    COUNT(*) FILTER (WHERE b = 'cancelado'),
    COALESCE(SUM(all_orders.valor) FILTER (WHERE b = 'cancelado'), 0),
    COUNT(*) FILTER (WHERE b = 'novedad'),
    COALESCE(SUM(all_orders.valor) FILTER (WHERE b = 'novedad'), 0),
    COUNT(*) FILTER (WHERE b = 'rechazado'),
    COALESCE(SUM(all_orders.valor) FILTER (WHERE b = 'rechazado'), 0)
  FROM all_orders;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.logistics_summary(date, date, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_by_carrier(date, date) — overload legacy
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_by_carrier(p_from_date date, p_to_date date)
 RETURNS TABLE(transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, novedades bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, avg_dias_entrega numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT o.transportadora AS carrier, o.valor, o.dias_conf, public._estado_bucket(o.estado) AS b
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      AND o.store_id = v_store
  ),
  base AS (
    SELECT * FROM raw WHERE b NOT IN ('cancelado', 'borrado')
  )
  SELECT
    base.carrier::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE b = 'entregado'),
    COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')),
    COUNT(*) FILTER (WHERE b = 'en_transito'),
    COUNT(*) FILTER (WHERE b = 'novedad'),
    ROUND((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    ROUND((COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    COALESCE(SUM(base.valor) FILTER (WHERE b = 'entregado'), 0),
    COALESCE(SUM(base.valor) FILTER (WHERE b IN ('devuelto', 'rechazado')), 0),
    ROUND(AVG(base.dias_conf) FILTER (WHERE b = 'entregado'), 1)
  FROM base
  GROUP BY base.carrier
  ORDER BY 3 DESC;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_by_carrier(date, date, text) — la del cliente. +rechazados → DROP.
-- Cohorte = DESPACHADO (excluye pendiente/preparación/cancelado/borrado; los
-- 'otros' con transportadora asignada se quedan — son tránsito sin mapear).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_by_carrier(date, date, text);

CREATE FUNCTION public.logistics_by_carrier(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, novedades bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, avg_dias_entrega numeric, rechazados bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT o.transportadora AS carrier, o.valor, o.dias_conf, public._estado_bucket(o.estado) AS b
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
      AND o.store_id = v_store
  ),
  base AS (
    SELECT * FROM raw WHERE b NOT IN ('cancelado', 'borrado', 'pendiente', 'preparacion')
  )
  SELECT
    base.carrier::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE b = 'entregado'),
    COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')),
    COUNT(*) FILTER (WHERE b = 'en_transito'),
    COUNT(*) FILTER (WHERE b = 'novedad'),
    ROUND((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    ROUND((COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    COALESCE(SUM(base.valor) FILTER (WHERE b = 'entregado'), 0),
    COALESCE(SUM(base.valor) FILTER (WHERE b IN ('devuelto', 'rechazado')), 0),
    ROUND(AVG(base.dias_conf) FILTER (WHERE b = 'entregado'), 1),
    COUNT(*) FILTER (WHERE b = 'rechazado')
  FROM base
  GROUP BY base.carrier
  ORDER BY 3 DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.logistics_by_carrier(date, date, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_by_city — +rechazados → DROP. Cohorte despachada (antes contaba
-- pendientes/preparación y diluía). Ranking por VOLUMEN de devoluciones (antes
-- por tasa diluida).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_by_city(date, date, integer);

CREATE FUNCTION public.logistics_by_city(p_from_date date, p_to_date date, p_limit integer DEFAULT 50)
 RETURNS TABLE(ciudad text, departamento text, total_pedidos bigint, entregados bigint, devueltos bigint, tasa_devolucion numeric, tasa_entrega numeric, valor_perdido numeric, rechazados bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT o.ciudad AS city, COALESCE(o.departamento, '') AS dep, o.valor, public._estado_bucket(o.estado) AS b
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.ciudad IS NOT NULL AND o.ciudad <> ''
      AND o.store_id = v_store
  ),
  base AS (
    SELECT * FROM raw WHERE b NOT IN ('cancelado', 'borrado', 'pendiente', 'preparacion')
  )
  SELECT
    base.city::TEXT,
    base.dep::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE b = 'entregado'),
    COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')),
    ROUND((COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    ROUND((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    COALESCE(SUM(base.valor) FILTER (WHERE b IN ('devuelto', 'rechazado')), 0),
    COUNT(*) FILTER (WHERE b = 'rechazado')
  FROM base
  GROUP BY base.city, base.dep
  ORDER BY 5 DESC, 3 DESC
  LIMIT p_limit;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.logistics_by_city(date, date, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_by_product — +rechazados +p_ciudad → DROP. Cohorte despachada.
-- Ranking por tasa MADURA ascendente (peor entrega real primero).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_by_product(date, date, integer);

CREATE FUNCTION public.logistics_by_product(p_from_date date, p_to_date date, p_limit integer DEFAULT 50, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(producto text, total_pedidos bigint, entregados bigint, devueltos bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, rechazados bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT o.producto AS prod, o.valor, public._estado_bucket(o.estado) AS b
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL AND o.producto <> ''
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
      AND o.store_id = v_store
  ),
  base AS (
    SELECT * FROM raw WHERE b NOT IN ('cancelado', 'borrado', 'pendiente', 'preparacion')
  )
  SELECT
    base.prod::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE b = 'entregado'),
    COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')),
    ROUND((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    ROUND((COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    COALESCE(SUM(base.valor) FILTER (WHERE b = 'entregado'), 0),
    COALESCE(SUM(base.valor) FILTER (WHERE b IN ('devuelto', 'rechazado')), 0),
    COUNT(*) FILTER (WHERE b = 'rechazado')
  FROM base
  GROUP BY base.prod
  ORDER BY
    ((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric
      / NULLIF((COUNT(*) FILTER (WHERE b = 'entregado')) + (COUNT(*) FILTER (WHERE b = 'devuelto')), 0)) ASC NULLS LAST,
    2 DESC
  LIMIT p_limit;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.logistics_by_product(date, date, integer, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_by_city_carrier — +rechazados → DROP. Cohorte despachada (antes
-- contaba hasta PENDIENTE CONFIRMACION en las celdas del heatmap).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_by_city_carrier(date, date, integer, integer);

CREATE FUNCTION public.logistics_by_city_carrier(p_from_date date, p_to_date date, p_min_orders integer DEFAULT 20, p_top_cities integer DEFAULT 20)
 RETURNS TABLE(ciudad text, departamento text, transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, tasa_entrega numeric, tasa_devolucion numeric, ciudad_total bigint, rechazados bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT o.ciudad AS city, COALESCE(o.departamento, '') AS dep, o.transportadora AS carrier,
           public._estado_bucket(o.estado) AS b
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.ciudad IS NOT NULL AND o.ciudad <> ''
      AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      AND o.store_id = v_store
  ),
  base AS (
    SELECT * FROM raw WHERE b NOT IN ('cancelado', 'borrado', 'pendiente', 'preparacion')
  ),
  city_volumes AS (
    SELECT base.city, COUNT(*) AS total FROM base
    GROUP BY base.city HAVING COUNT(*) >= p_min_orders
    ORDER BY total DESC LIMIT p_top_cities
  )
  SELECT
    base.city::TEXT, base.dep::TEXT, base.carrier::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE b = 'entregado'),
    COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')),
    ROUND((COUNT(*) FILTER (WHERE b = 'entregado'))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    ROUND((COUNT(*) FILTER (WHERE b IN ('devuelto', 'rechazado')))::numeric * 100.0 / NULLIF(COUNT(*), 0), 2),
    cv.total,
    COUNT(*) FILTER (WHERE b = 'rechazado')
  FROM base INNER JOIN city_volumes cv ON cv.city = base.city
  GROUP BY base.city, base.dep, base.carrier, cv.total
  HAVING COUNT(*) >= 5
  ORDER BY cv.total DESC, base.city ASC, 4 DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.logistics_by_city_carrier(date, date, integer, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_cost_basis — criterio de entregado unificado (suma EC
-- 'ENTREGADO A DESTINO'; sigue sin contar 'ENTREGADO A TRANSPORTADORA').
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_cost_basis(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(entregados bigint, ingresos_entregados numeric, cogs_entregados numeric, flete_entregados numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH entregadas AS (
    SELECT o.valor, o.costo_prod, o.flete
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND public._estado_bucket(o.estado) = 'entregado'
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
      AND o.store_id = v_store
  )
  SELECT
    COUNT(*)::bigint,
    COALESCE(SUM(valor), 0)::numeric,
    COALESCE(SUM(costo_prod), 0)::numeric,
    COALESCE(SUM(flete), 0)::numeric
  FROM entregadas;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- financial_summary — jsonb (sin cambio de firma). Fixes: excluye borrado;
-- entregados por bucket (ya no LIKE 'ENTREGAD%' que contaba 'ENTREGADO A
-- TRANSPORTADORA'); +total_rechazadas para que el cliente calcule la madura
-- sin rechazos. Los CTEs de wallet quedan idénticos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.financial_summary(p_from_date date, p_to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_store  uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN NULL; END IF;

  WITH
  raw AS MATERIALIZED (
    SELECT *, public._estado_bucket(estado) AS b FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND store_id = v_store
  ),
  filtered AS (
    SELECT * FROM raw WHERE b <> 'borrado'
  ),
  entregados AS (
    SELECT * FROM filtered WHERE b = 'entregado'
  ),
  devueltos AS (
    SELECT * FROM filtered WHERE b IN ('devuelto', 'rechazado')
  ),
  cancelados AS (
    SELECT * FROM filtered WHERE b = 'cancelado'
  ),
  wallet_range AS (
    SELECT * FROM public.dropi_wallet_movements
    WHERE fecha::date BETWEEN p_from_date AND p_to_date
      AND (v_store IS NULL OR store_id = v_store)
  ),
  agg AS (
    SELECT
      COALESCE((SELECT SUM(valor)      FROM entregados), 0) AS ingresos_brutos,
      COALESCE((SELECT SUM(costo_prod) FROM entregados), 0) AS cogs,
      COALESCE((SELECT SUM(flete)      FROM entregados), 0) AS flete_entregadas,
      COALESCE((SELECT SUM(flete)      FROM devueltos),  0) AS flete_devoluciones,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'costo_devolucion'),  0) AS cargo_extra_devoluciones,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'comision_referidos'),0) AS comision_referidos,
      COALESCE((SELECT SUM(monto) FROM wallet_range
                WHERE categoria IN ('ganancia_dropshipper','ganancia_proveedor')
                  AND tipo = 'ENTRADA'), 0) AS ganancia_markup,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'mantenimiento_tarjeta'), 0) AS mantenimiento_tarjeta,
      COALESCE((SELECT SUM(monto) FROM wallet_range
                WHERE categoria = 'indemnizacion'
                  AND tipo = 'ENTRADA'), 0) AS indemnizaciones,
      COALESCE((SELECT SUM(valor) FROM cancelados), 0) AS valor_cancelado,
      (SELECT COUNT(*) FROM cancelados) AS total_cancelados,
      (SELECT COUNT(*) FROM filtered)   AS total_ordenes,
      (SELECT COUNT(*) FROM entregados) AS total_entregadas,
      (SELECT COUNT(*) FROM devueltos)  AS total_devueltas,
      (SELECT COUNT(*) FROM filtered WHERE b = 'rechazado') AS total_rechazadas,
      COALESCE((SELECT AVG(valor) FROM entregados), 0) AS avg_ticket,
      COALESCE((SELECT SUM(
        CASE WHEN tipo = 'ENTRADA' THEN monto ELSE -monto END
      ) FROM wallet_range), 0) AS wallet_neto
  ),
  agg_calc AS (
    SELECT
      a.*,
      a.flete_devoluciones + a.cargo_extra_devoluciones AS perdida_total_devoluciones,
      CASE WHEN a.total_devueltas > 0
        THEN ROUND((a.flete_devoluciones + a.cargo_extra_devoluciones)::numeric / a.total_devueltas, 0)
        ELSE 0
      END AS costo_promedio_devolucion
    FROM agg a
  )
  SELECT jsonb_build_object(
    'ingresos_brutos',     a.ingresos_brutos,
    'cogs',                a.cogs,
    'flete_entregadas',    a.flete_entregadas,
    'flete_devoluciones',  a.flete_devoluciones,
    'comision_referidos',  a.comision_referidos,
    'ganancia_markup',     a.ganancia_markup,
    'valor_cancelado',     a.valor_cancelado,
    'total_cancelados',    a.total_cancelados,
    'tasa_cancelacion_pct',
      CASE WHEN a.total_ordenes > 0
        THEN ROUND(100.0 * a.total_cancelados::numeric / a.total_ordenes, 2)
        ELSE 0 END,
    'costo_devoluciones',  a.cargo_extra_devoluciones,
    'perdida_total_devoluciones', a.perdida_total_devoluciones,
    'costo_promedio_devolucion',  a.costo_promedio_devolucion,
    'mantenimiento_tarjeta',      a.mantenimiento_tarjeta,
    'indemnizaciones',            a.indemnizaciones,
    'utilidad_bruta',
        a.ingresos_brutos - a.cogs - a.flete_entregadas
      - a.perdida_total_devoluciones - a.comision_referidos
      - a.mantenimiento_tarjeta + a.indemnizaciones,
    'total_ordenes',       a.total_ordenes,
    'total_entregadas',    a.total_entregadas,
    'total_devueltas',     a.total_devueltas,
    'total_rechazadas',    a.total_rechazadas,
    'tasa_entrega_pct',
      CASE WHEN a.total_ordenes > 0
        THEN ROUND(100.0 * a.total_entregadas::numeric / a.total_ordenes, 2)
        ELSE 0 END,
    'ticket_promedio',
      CASE WHEN a.total_entregadas > 0
        THEN ROUND(a.avg_ticket::numeric, 0)
        ELSE 0 END,
    'wallet_neto',         a.wallet_neto
  ) INTO v_result FROM agg_calc a;

  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- product_profitability — FIX del 42702 (SUM(devueltos) sin calificar chocaba
-- con la columna OUT homónima → la RPC fallaba en TODAS las llamadas) + excluye
-- borrado + criterio de entregado por bucket + bucket UNA vez por fila.
-- Sin cambio de firma.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.product_profitability(p_from_date date, p_to_date date, p_limit integer DEFAULT 100)
 RETURNS TABLE(producto text, total_pedidos bigint, entregados bigint, devueltos bigint, cancelados bigint, en_transito bigint, ingresos_entregados numeric, costo_prod_entregados numeric, flete_inicial_entregados numeric, costo_devolucion_total numeric, utilidad_real numeric, utilidad_proyectada numeric, tasa_entrega numeric, tasa_devolucion numeric, tasa_cancelacion numeric, ticket_promedio numeric, margen_pct numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT o.producto AS prod, o.valor, o.costo_prod, o.flete, public._estado_bucket(o.estado) AS b
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL AND o.producto <> ''
      AND o.store_id = v_store
  ),
  agg AS (
    SELECT
      r.prod::TEXT AS producto,
      COUNT(*) AS total_pedidos,
      COUNT(*) FILTER (WHERE r.b = 'entregado') AS entregados,
      COUNT(*) FILTER (WHERE r.b IN ('devuelto', 'rechazado')) AS devueltos,
      COUNT(*) FILTER (WHERE r.b = 'cancelado') AS cancelados,
      COUNT(*) FILTER (WHERE r.b NOT IN ('entregado', 'devuelto', 'rechazado', 'cancelado')) AS en_transito,
      COALESCE(SUM(r.valor) FILTER (WHERE r.b = 'entregado'), 0) AS ingresos_entregados,
      COALESCE(SUM(r.costo_prod) FILTER (WHERE r.b = 'entregado'), 0) AS costo_prod_entregados,
      COALESCE(SUM(r.flete) FILTER (WHERE r.b = 'entregado'), 0) AS flete_inicial_entregados
    FROM raw r
    WHERE r.b <> 'borrado'
    GROUP BY r.prod
  ),
  wallet_attributed AS (
    SELECT o.producto::TEXT AS producto,
      COALESCE(SUM(ABS(w.monto)),0)::NUMERIC AS costo_attr
    FROM public.dropi_wallet_movements w
    JOIN public.orders o ON o.external_id IS NOT NULL AND w.related_order_id = o.external_id
    WHERE w.categoria='costo_devolucion'
      AND (w.fecha AT TIME ZONE 'America/Bogota')::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL AND o.producto <> ''
      AND (v_store IS NULL OR w.store_id = v_store)
      AND (v_store IS NULL OR o.store_id = v_store)
    GROUP BY o.producto
  ),
  wallet_unattributed_total AS (
    SELECT COALESCE(SUM(ABS(w.monto)),0)::NUMERIC AS total_unattr
    FROM public.dropi_wallet_movements w
    WHERE w.categoria='costo_devolucion'
      AND (w.fecha AT TIME ZONE 'America/Bogota')::date BETWEEN p_from_date AND p_to_date
      AND (v_store IS NULL OR w.store_id = v_store)
      AND (
        w.related_order_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.orders o2
          WHERE o2.external_id = w.related_order_id
            AND o2.producto IS NOT NULL AND o2.producto <> ''
            AND (v_store IS NULL OR o2.store_id = v_store)
        )
      )
  ),
  -- FIX 42702: `SUM(devueltos)` sin calificar era ambiguo con la columna OUT.
  total_devueltos AS (SELECT COALESCE(SUM(agg.devueltos),0)::NUMERIC AS total_dev FROM agg),
  costo_dev_blended AS (
    SELECT a.producto,
      COALESCE(wa.costo_attr,0)
        + CASE WHEN (SELECT total_dev FROM total_devueltos) > 0
            THEN (a.devueltos::NUMERIC/(SELECT total_dev FROM total_devueltos))*(SELECT total_unattr FROM wallet_unattributed_total)
            ELSE 0 END AS costo_devolucion_real
    FROM agg a LEFT JOIN wallet_attributed wa ON wa.producto = a.producto
  ),
  with_calc AS (
    SELECT a.*, cdb.costo_devolucion_real AS costo_devolucion_total,
      (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados - cdb.costo_devolucion_real) AS utilidad_real_calc,
      CASE WHEN a.entregados>0 THEN (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados)/a.entregados ELSE 0 END AS utilidad_prom_entrega,
      CASE WHEN a.devueltos>0 THEN cdb.costo_devolucion_real/a.devueltos ELSE 0 END AS costo_prom_devolucion,
      CASE WHEN (a.entregados+a.devueltos+a.en_transito)>0 THEN a.entregados::NUMERIC/(a.entregados+a.devueltos+a.en_transito) ELSE 0 END AS p_entrega,
      CASE WHEN (a.entregados+a.devueltos+a.en_transito)>0 THEN a.devueltos::NUMERIC/(a.entregados+a.devueltos+a.en_transito) ELSE 0 END AS p_devolucion
    FROM agg a LEFT JOIN costo_dev_blended cdb ON cdb.producto = a.producto
  )
  SELECT
    wc.producto, wc.total_pedidos, wc.entregados, wc.devueltos, wc.cancelados, wc.en_transito,
    wc.ingresos_entregados, wc.costo_prod_entregados, wc.flete_inicial_entregados,
    ROUND(wc.costo_devolucion_total::NUMERIC,0),
    ROUND(wc.utilidad_real_calc::NUMERIC,0),
    ROUND((wc.utilidad_real_calc + wc.en_transito*wc.p_entrega*wc.utilidad_prom_entrega - wc.en_transito*wc.p_devolucion*wc.costo_prom_devolucion)::NUMERIC,0),
    ROUND(wc.p_entrega*100,2),
    ROUND(wc.p_devolucion*100,2),
    CASE WHEN wc.total_pedidos>0 THEN ROUND(wc.cancelados::NUMERIC*100/wc.total_pedidos,2) ELSE 0 END,
    CASE WHEN wc.entregados>0 THEN ROUND(wc.ingresos_entregados/wc.entregados,0) ELSE 0 END,
    CASE WHEN wc.ingresos_entregados>0 THEN ROUND(wc.utilidad_real_calc*100/wc.ingresos_entregados,2) ELSE 0 END
  FROM with_calc wc
  ORDER BY wc.utilidad_real_calc DESC
  LIMIT p_limit;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- orders_estado_breakdown — el embudo del cliente. Excluye borrado (paridad
-- Dropi: una orden reemplazada/soft-borrada no existe) + p_ciudad → DROP
-- (agregar un parámetro con DEFAULT crea una firma nueva; sin DROP quedarían
-- las dos y PostgREST se confunde).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.orders_estado_breakdown(date, date);

CREATE FUNCTION public.orders_estado_breakdown(p_from date, p_to date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(estado text, pedidos bigint, valor numeric, unidades numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    UPPER(COALESCE(NULLIF(TRIM(o.estado), ''), '(sin estado)')) AS estado,
    COUNT(*)::bigint,
    COALESCE(SUM(o.valor), 0)::numeric,
    COALESCE(SUM(COALESCE(o.cantidad, 0)), 0)::numeric
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from AND p_to
    AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
    AND o.store_id = v_store
    AND public._estado_bucket(o.estado) <> 'borrado'
  GROUP BY UPPER(COALESCE(NULLIF(TRIM(o.estado), ''), '(sin estado)'));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.orders_estado_breakdown(date, date, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- logistics_timeline — el drill-down tampoco debe listar borradas + p_ciudad.
-- DROP porque agregar un parámetro con DEFAULT crea una firma nueva.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_timeline(date, date, text[], text, text, integer, integer);

CREATE FUNCTION public.logistics_timeline(
  p_from_date      DATE,
  p_to_date        DATE,
  p_estados        TEXT[] DEFAULT NULL,
  p_transportadora TEXT   DEFAULT NULL,
  p_search         TEXT   DEFAULT NULL,
  p_limit          INTEGER DEFAULT 50,
  p_offset         INTEGER DEFAULT 0,
  p_ciudad         TEXT   DEFAULT NULL
)
RETURNS TABLE (
  id              UUID,
  fecha           DATE,
  guia            TEXT,
  external_id     TEXT,
  estado          TEXT,
  transportadora  TEXT,
  ciudad          TEXT,
  producto        TEXT,
  valor           NUMERIC,
  total_count     BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store uuid;
  v_search_pattern TEXT;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  v_search_pattern := CASE
    WHEN p_search IS NULL OR p_search = '' THEN NULL
    ELSE '%' || p_search || '%'
  END;

  RETURN QUERY
  WITH filtered AS (
    SELECT o.id, o.fecha, o.guia, o.external_id, o.estado,
           o.transportadora, o.ciudad, o.producto, o.valor, o.created_at
    FROM public.orders o
    WHERE o.store_id = v_store
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND public._estado_bucket(o.estado) <> 'borrado'
      AND (p_estados IS NULL OR UPPER(COALESCE(o.estado, '')) = ANY(p_estados))
      AND (p_transportadora IS NULL OR p_transportadora = '' OR o.transportadora = p_transportadora)
      AND (p_ciudad IS NULL OR p_ciudad = '' OR o.ciudad = p_ciudad)
      AND (
        v_search_pattern IS NULL
        OR o.guia ILIKE v_search_pattern
        OR o.external_id ILIKE v_search_pattern
      )
  ),
  counted AS (
    SELECT COUNT(*) AS n FROM filtered
  )
  SELECT
    f.id,
    f.fecha::date,
    COALESCE(f.guia, '')::TEXT,
    COALESCE(f.external_id, '')::TEXT,
    COALESCE(f.estado, '')::TEXT,
    COALESCE(f.transportadora, '')::TEXT,
    COALESCE(f.ciudad, '')::TEXT,
    COALESCE(f.producto, '')::TEXT,
    COALESCE(f.valor, 0)::NUMERIC,
    counted.n AS total_count
  FROM filtered f, counted
  ORDER BY f.fecha::date DESC, f.created_at DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_timeline(DATE, DATE, TEXT[], TEXT, TEXT, INTEGER, INTEGER, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_top_cities — el dropdown de ciudades no debe rankear con borradas.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_top_cities(
  p_limit INTEGER DEFAULT 200
)
RETURNS TABLE (
  ciudad        TEXT,
  departamento  TEXT,
  total_pedidos BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    o.ciudad::TEXT,
    COALESCE(o.departamento, '')::TEXT AS departamento,
    COUNT(*) AS total_pedidos
  FROM public.orders o
  WHERE o.store_id = v_store
    AND o.ciudad IS NOT NULL AND o.ciudad <> ''
    AND public._estado_bucket(o.estado) <> 'borrado'
  GROUP BY o.ciudad, COALESCE(o.departamento, '')
  ORDER BY total_pedidos DESC
  LIMIT p_limit;
END;
$func$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Billetera para socios: la tabla dropi_wallet_movements era SELECT admin-only
-- (wallet_admin_select) mientras los agregados (wallet_summary, SECURITY
-- DEFINER) sí salían — el socio veía "Entradas $X" con la lista vacía.
-- Owner/supervisor de la tienda pueden LEER sus movimientos; INSERT/UPDATE
-- siguen bloqueados (todo entra por upsert_wallet_movements).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS wallet_member_select ON public.dropi_wallet_movements;
CREATE POLICY wallet_member_select ON public.dropi_wallet_movements
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.user_id = auth.uid()
        AND sm.store_id = dropi_wallet_movements.store_id
        AND sm.role IN ('owner', 'supervisor')
    )
  );
