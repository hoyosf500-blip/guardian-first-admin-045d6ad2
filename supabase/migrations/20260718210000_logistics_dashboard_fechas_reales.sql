-- ============================================================================
-- logistics_dashboard: que OBEDEZCA el rango de fechas elegido.
--
-- EL BUG QUE ARREGLA
-- La versión vieja recibía `p_range text` ('7d'|'30d'|'90d') y adentro hacía
-- `NOW() - INTERVAL 'N days'`: una ventana RODANTE pegada a hoy. El cliente le
-- tiraba las fechas y le mandaba solo la duración, así que elegir "1 jun →
-- 30 jun" (30 días) devolvía "últimos 30 días". El encabezado decía junio, las
-- tablas de al lado mostraban junio, y 4 gráficas mostraban otro mes. Peor:
-- junio y mayo caían en el mismo bucket '30d', así que cambiar de mes NI
-- SIQUIERA disparaba una consulta nueva.
-- No es "inventar datos": son datos reales de OTRO período, rotulados como el
-- que el usuario pidió. Por eso se arregla acá y no con un rótulo.
--
-- LOS NÚMEROS SE VAN A MOVER, Y ESTÁ BIEN
-- La vieja filtraba por `created_at` (cuándo entró el pedido a NUESTRA base).
-- Todo el resto de /logistica filtra por `orders.fecha` (la fecha del pedido).
-- Por eso las 4 gráficas nunca iban a cuadrar con las tablas de al lado ni
-- corrigiendo el rango: contaban por otro campo, y `created_at` además corre el
-- corte por zona horaria. Ahora usa `fecha`, con el mismo guard de formato que
-- sus hermanas.
--
-- ALCANCE (patrón de la migración 20260707050637)
-- La vieja exigía `has_role(admin)`. Sus hermanas de la misma pantalla
-- (logistics_summary, logistics_by_city…) no: resuelven con
-- `_resolve_scope_store()`, que ya lanza 42501 si no sos owner/supervisor. Un
-- supervisor que veía las tablas veía las gráficas romperse.
-- Filtro de tienda DURO (`o.store_id = v_store`), no el permisivo
-- `(v_store IS NULL OR ...)`: con el permisivo, un admin sin tienda activa
-- mezcla Colombia con Ecuador en silencio. Con el duro no devuelve filas, y las
-- gráficas ya tienen estado vacío para decirlo.
--
-- `p_ciudad` es nuevo: el filtro de ciudad de la pantalla tampoco llegaba acá.
--
-- LA VIEJA NO SE BORRA A PROPÓSITO. El overload `(text)` queda intacto para no
-- abrir una ventana de error entre que se aplica este SQL y que Lovable publica
-- el cliente nuevo. Las firmas no se pisan: PostgREST manda argumentos con
-- nombre y ninguna llamada puede matchear las dos. Ya con el cliente publicado
-- y verificado, se puede limpiar con:
--     DROP FUNCTION IF EXISTS public.logistics_dashboard(text);
--
-- Los buckets de estado, el HAVING >= 5 y la forma del JSON quedan IDÉNTICOS:
-- el cliente no cambia de tipos. El WHERE se repite en cada bloque en vez de
-- factorizarlo en un CTE, a propósito: mantiene la estructura de la función que
-- ya funcionaba y hace el diff auditable línea por línea.
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
          COUNT(*) FILTER (WHERE o.estado = 'ENTREGADO')::int AS entregados,
          COUNT(*) FILTER (WHERE o.estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO'))::int AS devueltos,
          COUNT(*) FILTER (WHERE o.estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO'))::int AS en_transito
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
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
          AND o.transportadora IS NOT NULL AND o.transportadora <> ''
        GROUP BY o.fecha::date, o.transportadora
        ORDER BY o.fecha::date
      ) t
    ), '[]'::jsonb),
    'by_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT
          CASE
            WHEN o.estado = 'ENTREGADO' THEN 'Entregada a destino'
            WHEN o.estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO') THEN 'Devolucion a origen'
            WHEN o.estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO') THEN 'En transito'
            WHEN o.estado IN ('NOVEDAD','INTENTO DE ENTREGA') THEN 'Novedad'
            WHEN o.estado = 'RECHAZADO' THEN 'Rechazada'
            WHEN o.estado IN ('PENDIENTE CONFIRMACION','CONFIRMADO') THEN 'En preparacion'
            WHEN o.estado = 'CANCELADO' THEN 'Cancelada'
            ELSE 'Otro'
          END AS estado_agrupado,
          COUNT(*)::int AS total
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
        GROUP BY 1 ORDER BY 2 DESC
      ) t
    ), '[]'::jsonb),
    'by_date_and_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT o.fecha::date AS fecha,
          COUNT(*) FILTER (WHERE o.estado = 'ENTREGADO')::int AS entregada,
          COUNT(*) FILTER (WHERE o.estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO'))::int AS devolucion,
          COUNT(*) FILTER (WHERE o.estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO'))::int AS transito,
          COUNT(*) FILTER (WHERE o.estado IN ('NOVEDAD','INTENTO DE ENTREGA'))::int AS novedad,
          COUNT(*) FILTER (WHERE o.estado = 'RECHAZADO')::int AS rechazada
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
        GROUP BY o.fecha::date ORDER BY o.fecha::date
      ) t
    ), '[]'::jsonb),
    'by_transportadora_and_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT o.transportadora,
          COUNT(*) FILTER (WHERE o.estado = 'ENTREGADO')::int AS entregada,
          COUNT(*) FILTER (WHERE o.estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO'))::int AS devolucion,
          COUNT(*) FILTER (WHERE o.estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO'))::int AS transito,
          COUNT(*) FILTER (WHERE o.estado IN ('NOVEDAD','INTENTO DE ENTREGA'))::int AS novedad,
          COUNT(*) FILTER (WHERE o.estado = 'RECHAZADO')::int AS rechazada,
          COUNT(*)::int AS total
        FROM public.orders o
        WHERE o.store_id = v_store
          AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
          AND o.fecha::date BETWEEN p_from_date AND p_to_date
          AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
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
