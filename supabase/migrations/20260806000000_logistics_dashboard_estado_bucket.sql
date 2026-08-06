-- ============================================================================
-- logistics_dashboard: dejar de contar pedidos BORRADOS y de mandar Ecuador a
-- "Otro".
--
-- VERIFICADO CONTRA PRODUCCIÓN ANTES DE ESCRIBIR (regla #1)
-- Se pidió el `pg_get_functiondef` de la función que está corriendo el 2026-08-05
-- y el cuerpo del overload (date, date, text) coincide EXACTAMENTE con el de la
-- migración 20260718210000. No hay drift: este CREATE OR REPLACE parte de la
-- versión desplegada, no de una suposición del repo.
--
-- LOS DOS BUGS
--
-- 1. NO EXCLUÍA LOS SOFT-BORRADOS. Es la ÚNICA función de logística sin el
--    filtro `_estado_bucket(estado) <> 'borrado'` (lo tienen logistics_summary,
--    by_carrier, by_city, by_product, orders_estado_breakdown, timeline…).
--    Medido en la tienda de Ecuador, mayo–julio 2026: 425 REEMPLAZADA + 102
--    ARCHIVADO GHOST = 527 pedidos que Dropi borró o reemplazó por edición, y
--    que acá inflaban el `total` de los KPIs y aparecían como una tajada de
--    "Otro" en la torta. Es el mismo ~30% de pedidos fantasma que apareció al
--    conciliar julio contra la billetera.
--
-- 2. LAS LISTAS DE ESTADO ERAN SOLO DE COLOMBIA. `EN TRANSPORTE`, `EN DESPACHO`,
--    `EN TRASLADO NACIONAL`, `EN REPARTO` — escritas a mano. Ecuador manda otros
--    nombres, así que caían en "Otro" pese a estar perfectamente clasificados por
--    `_estado_bucket`. Medido en el mismo rango: 92 pedidos VIVOS mal ubicados —
--    35 novedades (32 de ellas `PARA RETIRO EN AGENCIA SERVIENTREGA`, que es
--    riesgo de no-entrega y hay que gestionar), 41 en tránsito (`ZONA DE ENTREGA`,
--    `EN TRÁNSITO` con tilde, `INGRESANDO OPERATIVO A`, `EN DISTRIBUCIÓN A
--    CLIENTE`, `EN RUTA A CENTRO LOGISTICO`), 13 pendientes y 3 en preparación.
--
-- EL ARREGLO
-- Se reemplazan las listas literales por `public._estado_bucket(o.estado)`, que
-- ya es la fuente única del resto del módulo (normaliza mayúsculas, guiones bajos
-- y acentos, y tiene los fallbacks por contenido de las transportadoras de EC).
-- Así un estado nuevo de Dropi se mapea en UN solo lugar y estas 4 gráficas lo
-- toman sin tocarlas.
--
-- LOS NÚMEROS SE VAN A MOVER, Y ESTÁ BIEN. El `total` de los KPIs baja (salen los
-- borrados) y la tajada "Otro" de la torta se desinfla hacia tránsito/novedad/
-- pendiente. Lo que se va no era operación: eran registros que Dropi ya no tiene.
--
-- CAMBIO DE CONTRATO (menor): `by_estado` ahora emite la etiqueta 'Pendiente'
-- aparte de 'En preparacion'. Antes las dos se fundían en 'En preparacion', que
-- mezclaba "nunca salió" con "tiene guía y está por salir" — dos cosas que el
-- dueño mira distinto. El cliente resuelve el color por diccionario CON FALLBACK
-- (`ESTADO_COLORS[x] ?? muted`), así que si esta migración se aplica antes de que
-- el front se publique, la tajada nueva sale gris pero NADA se rompe.
--
-- No se toca el overload legacy `logistics_dashboard(text)` acá — ver la nota al
-- pie sobre por qué conviene borrarlo por separado.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.logistics_dashboard(
  p_from_date date,
  p_to_date   date,
  p_ciudad    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store  uuid;
  v_result jsonb;
BEGIN
  -- Lanza 42501 si no es admin ni owner/supervisor de alguna tienda.
  v_store := public._resolve_scope_store();

  SELECT jsonb_build_object(
    'kpis', (
      SELECT row_to_json(t) FROM (
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'entregado')::int   AS entregados,
          -- 'devuelto' SIN 'rechazado': se mantiene la semántica que ya tenía la
          -- función (el rechazo del cliente es su propia serie en las gráficas).
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'devuelto')::int    AS devueltos,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'en_transito')::int AS en_transito
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
          AND public._estado_bucket(o.estado) <> 'borrado'
      ) t
    ),
    'by_transportadora', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT o.transportadora, COUNT(*)::int AS total
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
          AND public._estado_bucket(o.estado) <> 'borrado'
          AND o.transportadora IS NOT NULL AND o.transportadora <> ''
        GROUP BY o.transportadora HAVING COUNT(*) >= 5
        ORDER BY COUNT(*) DESC
      ) t
    ), '[]'::jsonb),
    'by_transportadora_and_date', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT o.fecha::date AS fecha, o.transportadora, COUNT(*)::int AS total
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
          AND public._estado_bucket(o.estado) <> 'borrado'
          AND o.transportadora IS NOT NULL AND o.transportadora <> ''
        GROUP BY o.fecha::date, o.transportadora
        ORDER BY o.fecha::date
      ) t
    ), '[]'::jsonb),
    'by_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT
          CASE public._estado_bucket(o.estado)
            WHEN 'entregado'   THEN 'Entregada a destino'
            WHEN 'devuelto'    THEN 'Devolucion a origen'
            WHEN 'en_transito' THEN 'En transito'
            WHEN 'novedad'     THEN 'Novedad'
            WHEN 'rechazado'   THEN 'Rechazada'
            WHEN 'preparacion' THEN 'En preparacion'
            WHEN 'pendiente'   THEN 'Pendiente'
            WHEN 'cancelado'   THEN 'Cancelada'
            ELSE 'Otro'
          END AS estado_agrupado,
          COUNT(*)::int AS total
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
          AND public._estado_bucket(o.estado) <> 'borrado'
        GROUP BY 1 ORDER BY 2 DESC
      ) t
    ), '[]'::jsonb),
    'by_date_and_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT o.fecha::date AS fecha,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'entregado')::int   AS entregada,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'devuelto')::int    AS devolucion,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'en_transito')::int AS transito,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'novedad')::int     AS novedad,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'rechazado')::int   AS rechazada
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
          AND public._estado_bucket(o.estado) <> 'borrado'
        GROUP BY o.fecha::date ORDER BY o.fecha::date
      ) t
    ), '[]'::jsonb),
    'by_transportadora_and_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT o.transportadora,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'entregado')::int   AS entregada,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'devuelto')::int    AS devolucion,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'en_transito')::int AS transito,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'novedad')::int     AS novedad,
          COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'rechazado')::int   AS rechazada,
          COUNT(*)::int AS total
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
          AND public._estado_bucket(o.estado) <> 'borrado'
          AND o.transportadora IS NOT NULL AND o.transportadora <> ''
        GROUP BY o.transportadora HAVING COUNT(*) >= 5
        ORDER BY COUNT(*) DESC
      ) t
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_dashboard(date, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- PENDIENTE APARTE — el overload legacy `logistics_dashboard(text)`
--
-- Sigue desplegado y lee `FROM orders WHERE created_at >= v_since` SIN filtro de
-- `store_id`: mezcla Colombia con Ecuador en una sola respuesta. Es admin-only,
-- así que solo el dueño podría dispararlo, y el cliente actual no puede llegarle
-- (PostgREST manda argumentos con nombre y ninguna llamada matchea las dos
-- firmas). Se dejó vivo a propósito en 20260718210000 para no abrir un hueco
-- entre el SQL y la publicación del front.
--
-- Ese front ya está publicado, así que el overload ya no protege nada y sí deja
-- un camino a mezclar países. Borrarlo es una línea, pero es DESTRUCTIVO y va
-- por decisión explícita del dueño — por eso queda comentado acá y no se ejecuta:
--
--   DROP FUNCTION IF EXISTS public.logistics_dashboard(text);
-- ────────────────────────────────────────────────────────────────────────────
