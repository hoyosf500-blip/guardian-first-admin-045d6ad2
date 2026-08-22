-- Tasa de cancelación POR PRODUCTO — el denominador, que es lo que faltaba.
--
-- ADITIVA: crea UNA función nueva. **No toca `cancelaciones_analisis`** ni
-- ninguna otra función viva (⛔ REGLA #1).
--
-- ── Por qué ────────────────────────────────────────────────────────────────
-- La tarjeta "Por producto" de /logistica → Cancelaciones mostraba CUÁNTAS
-- cancelaciones tenía cada producto, no la TASA. Con eso, el producto más
-- vendido encabeza siempre y la pantalla no puede contestar "¿cuál me está
-- cancelando más?". Medido en agosto-2026 (Ecuador):
--
--   Gafas Bluetooth ....... 109 cancelaciones (51% del total)  → tasa 28,3%
--   Freidora con canasta ... 35 cancelaciones (16%)            → tasa 39,8%  ← la peor
--   Aurelis / Drenaje ...... 20 cancelaciones ( 9%)            → tasa 35,1%
--
-- El peor producto era la Freidora y la pantalla decía que eran las Gafas.
--
-- ── Qué devuelve y qué NO ──────────────────────────────────────────────────
-- Devuelve SOLO conteos: el denominador y los buckets terminales. La tasa, la
-- guarda de volumen mínimo y la detección de publicaciones hermanas se calculan
-- en `src/lib/cancelacionesPorProducto.ts`, igual que `cancelaciones_analisis`
-- deja la clasificación en `src/lib/cancelTaxonomy.ts`: así se puede cambiar el
-- criterio sin una migración, y se puede probar.
--
-- El MOTIVO dominante tampoco viaja acá: el cliente ya tiene una fila por
-- pedido cancelado (con su producto y su motivo) desde `cancelaciones_analisis`.
-- Pedirlo de nuevo sería un segundo camino para el mismo dato, y dos caminos
-- se desincronizan.
--
-- ── La cohorte es la MISMA de `cancelaciones_analisis` ─────────────────────
-- Por `orders.fecha` con guard de formato, `_estado_bucket <> 'borrado'`.
-- Si las dos difirieran, la tasa por producto no sumaría la tasa general y no
-- habría forma de auditar cuál de las dos miente.

CREATE OR REPLACE FUNCTION public.cancelaciones_por_producto(
  p_store_id uuid,
  p_desde    date,
  p_hasta    date,
  p_limite   integer DEFAULT 300
)
RETURNS TABLE (
  producto         text,
  generados        bigint,
  cancelados       bigint,
  entregados       bigint,
  devueltos        bigint,
  pendientes       bigint,
  en_curso         bigint,
  valor_generado   numeric,
  valor_cancelado  numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Mismo gate que `cancelaciones_analisis`: es un reporte de gestión.
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado para ver las cancelaciones de esta tienda'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    -- El nombre va TAL CUAL viene, sin normalizar. Dos publicaciones del mismo
    -- producto tienen que quedar en filas distintas: en agosto la Freidora "con
    -- canasta winner" canceló 39,8% y "FREIDORA IMP WINNER" 11,8%. Fusionarlas
    -- acá borraría el hallazgo — que el problema es el anuncio y no el producto.
    -- Emparejarlas para mostrarlas juntas es trabajo del cliente.
    COALESCE(NULLIF(btrim(o.producto), ''), '(sin producto)')          AS producto,
    COUNT(*)::bigint                                                    AS generados,
    COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'cancelado')::bigint AS cancelados,
    COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'entregado')::bigint AS entregados,
    COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'devuelto')::bigint  AS devueltos,
    -- `pendiente` es lo que TODAVÍA puede cancelarse: sale del denominador de la
    -- tasa madura. Un producto con 20 pedidos de los cuales 15 siguen pendientes
    -- no puede publicar un porcentaje.
    COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'pendiente')::bigint AS pendientes,
    COUNT(*) FILTER (
      WHERE public._estado_bucket(o.estado) IN ('preparacion','en_transito','novedad','rechazado','otros')
    )::bigint                                                           AS en_curso,
    COALESCE(SUM(o.valor), 0)::numeric                                  AS valor_generado,
    COALESCE(SUM(o.valor) FILTER (WHERE public._estado_bucket(o.estado) = 'cancelado'), 0)::numeric
                                                                        AS valor_cancelado
  FROM public.orders o
  WHERE o.store_id = p_store_id
    AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date >= p_desde
    AND o.fecha::date <= p_hasta
    AND public._estado_bucket(o.estado) <> 'borrado'
  GROUP BY 1
  -- Se ordena por VOLUMEN, no por tasa: el orden final por tasa lo decide el
  -- cliente después de aplicar la guarda de mínimo. Si ordenara por tasa acá, un
  -- producto de 2 pedidos con 1 cancelación (50%) se comería el LIMIT y
  -- desplazaría a los que de verdad mueven plata.
  ORDER BY COUNT(*) DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limite, 300), 1), 1000);
END;
$$;

REVOKE ALL ON FUNCTION public.cancelaciones_por_producto(uuid, date, date, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancelaciones_por_producto(uuid, date, date, integer) TO authenticated;

COMMENT ON FUNCTION public.cancelaciones_por_producto(uuid, date, date, integer) IS
  'Conteos por producto para la tasa de cancelación. Misma cohorte que cancelaciones_analisis (orders.fecha, borrado excluido). NO normaliza el nombre del producto a propósito: dos publicaciones del mismo producto cancelan distinto y esa diferencia es el dato. La tasa y la guarda de volumen viven en src/lib/cancelacionesPorProducto.ts.';
