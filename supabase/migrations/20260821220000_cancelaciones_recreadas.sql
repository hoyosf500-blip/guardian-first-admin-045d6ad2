-- Cancelaciones que NO son pérdidas: el pedido se recreó con otro número.
--
-- ADITIVA: crea UNA función nueva. **No toca `cancelaciones_analisis`** ni
-- ninguna otra función viva (⛔ REGLA #1). El cliente llama a las dos y cruza
-- los `order_id`.
--
-- ── Por qué hace falta ──────────────────────────────────────────────────────
-- Auditoría de agosto-2026 en Ecuador, sobre 211 cancelados:
--
--   · 24  (11%) marcados en Guardian, con motivo escrito.
--   · 19  ( 9%) **reemplazos**: el pedido volvió a entrar con otro external_id
--               en menos de 48 h, mismo cliente y mismo producto.
--   · 168 (80%) cancelados fuera del CRM, sin explicación.
--
-- Los 19 no se perdieron: se rehicieron. `cancelTaxonomy` ya sabe descontarlos
-- —`cuentaEnTasa:false`— pero **solo cuando alguien escribió el motivo**, y
-- estos justamente no lo tienen. Sin esta función siguen contando como venta
-- perdida y, como la venta buena también entra, la misma plata se cuenta dos
-- veces: una como cancelada y otra como nueva.
--
-- ── Es una HEURÍSTICA, y se declara como tal ────────────────────────────────
-- Espeja el criterio de `cancel_orphan_pending_orders`
-- (`20260528120000_cancel_orphan_extended.sql:18-49`), que es el proceso que
-- crea la mayoría de estos casos: mismo teléfono + mismo producto + el sucesor
-- nace dentro de las 48 h + el sucesor NO está cancelado ni pendiente.
--
-- No se afirma que sea el mismo pedido: se afirma que **hay un sucesor vivo con
-- el mismo cliente y el mismo producto**. Por eso devuelve el `external_id` del
-- sucesor — para que cualquiera pueda ir a mirarlo y desmentirlo.
--
-- Deliberadamente NO se usa el valor para emparejar: un cambio de
-- transportadora cambia el flete y el total. Emparejar por monto perdería justo
-- los casos que se buscan.

CREATE OR REPLACE FUNCTION public.cancelaciones_recreadas(
  p_store_id uuid,
  p_desde    date,
  p_hasta    date,
  p_limite   integer DEFAULT 3000
)
RETURNS TABLE (
  order_id             uuid,
  external_id          text,
  sucesor_external_id  text,
  sucesor_estado       text,
  horas_hasta_sucesor  numeric,
  valor                numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Mismo gate que `cancelaciones_analisis`: esto es un reporte de gestión.
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado para ver las cancelaciones de esta tienda'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    viejo.id,
    viejo.external_id,
    suc.external_id,
    suc.estado,
    ROUND(EXTRACT(EPOCH FROM (suc.created_at - viejo.created_at)) / 3600.0, 1),
    viejo.valor
  FROM public.orders viejo
  -- El sucesor: mismo cliente, mismo producto, nacido después y dentro de 48 h.
  -- LATERAL con LIMIT 1 y no un JOIN: si hubiera dos candidatos, un JOIN
  -- duplicaría la fila del cancelado y el conteo saldría inflado — justo el
  -- error que esta función viene a corregir.
  JOIN LATERAL (
    SELECT n.external_id, n.estado, n.created_at
    FROM public.orders n
    WHERE n.store_id = viejo.store_id
      AND n.id <> viejo.id
      AND n.phone = viejo.phone
      AND UPPER(BTRIM(COALESCE(n.producto, ''))) = UPPER(BTRIM(COALESCE(viejo.producto, '')))
      AND n.created_at >  viejo.created_at
      AND n.created_at <= viejo.created_at + INTERVAL '48 hours'
      AND UPPER(COALESCE(n.estado, '')) NOT IN ('CANCELADO', 'PENDIENTE CONFIRMACION')
    ORDER BY n.created_at ASC
    LIMIT 1
  ) suc ON TRUE
  WHERE viejo.store_id = p_store_id
    AND public._estado_bucket(viejo.estado) = 'cancelado'
    -- Misma cohorte que `cancelaciones_analisis`: por `orders.fecha`, con el
    -- mismo guard de formato (hay filas con fecha mal escrita).
    AND viejo.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND viejo.fecha::date BETWEEN p_desde AND p_hasta
    AND COALESCE(viejo.phone, '') <> ''
    -- Si una asesora YA escribió el motivo, manda su palabra: la taxonomía lo
    -- clasifica por texto y esta heurística no tiene por qué opinar encima.
    AND NOT EXISTS (
      SELECT 1 FROM public.order_results orr
      WHERE orr.order_id = viejo.id AND orr.result = 'canc'
    )
  ORDER BY viejo.valor DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limite, 3000), 1), 5000);
END;
$$;

REVOKE ALL ON FUNCTION public.cancelaciones_recreadas(uuid, date, date, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancelaciones_recreadas(uuid, date, date, integer) TO authenticated;
