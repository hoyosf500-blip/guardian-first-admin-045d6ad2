-- wallet_ganancia_neta — ganancia neta OPERATIVA del wallet por tienda.
--
-- Por qué existe: el hook useGananciaNetaDropi hacía un SELECT directo a
-- dropi_wallet_movements, cuya RLS es admin-only (wallet_admin_select). Eso
-- significaba que un SOCIO (owner/supervisor, no admin) veía ganancia neta = 0
-- en Logística → Resumen / Finanzas. Esta RPC es SECURITY DEFINER + scopeada
-- por _resolve_scope_store() (mismo patrón que wallet_summary), SIN gate admin,
-- así el socio ve la ganancia de SU tienda (nunca cross-store) sin abrir la RLS
-- de la tabla.
--
-- "Operativa" = solo categorías que mueven la ganancia real. Excluye
-- retiros/depósitos/transferencias (tesorería) y 'otro' (sin clasificar).
-- Mismas categorías que ENTRADAS_OPERATIVAS / SALIDAS_OPERATIVAS del hook.
-- Toma ABS(monto) porque las salidas pueden venir negativas en Dropi.

CREATE OR REPLACE FUNCTION public.wallet_ganancia_neta(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  total_entradas        numeric,
  total_salidas         numeric,
  ganancia_neta         numeric,
  movimientos_count     bigint,
  ganancia_dropshipper  numeric,
  ganancia_proveedor    numeric,
  reembolso_flete       numeric,
  indemnizacion         numeric,
  flete_inicial         numeric,
  costo_devolucion      numeric,
  comision_referidos    numeric,
  mantenimiento_tarjeta numeric,
  orden_sin_recaudo     numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  RETURN QUERY
  WITH base AS (
    SELECT m.categoria AS cat, ABS(COALESCE(m.monto, 0)) AS monto
    FROM public.dropi_wallet_movements m
    WHERE m.fecha >= p_from AND m.fecha <= p_to
      AND (v_store IS NULL OR m.store_id = v_store)
      AND m.categoria IN (
        'ganancia_dropshipper','ganancia_proveedor','reembolso_flete','indemnizacion',
        'flete_inicial','costo_devolucion','comision_referidos','mantenimiento_tarjeta','orden_sin_recaudo'
      )
  ),
  agg AS (
    SELECT
      COALESCE(SUM(monto) FILTER (WHERE cat = 'ganancia_dropshipper'),  0) AS ganancia_dropshipper,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'ganancia_proveedor'),    0) AS ganancia_proveedor,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'reembolso_flete'),       0) AS reembolso_flete,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'indemnizacion'),         0) AS indemnizacion,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'flete_inicial'),         0) AS flete_inicial,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'costo_devolucion'),      0) AS costo_devolucion,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'comision_referidos'),    0) AS comision_referidos,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'mantenimiento_tarjeta'), 0) AS mantenimiento_tarjeta,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'orden_sin_recaudo'),     0) AS orden_sin_recaudo,
      COUNT(*) AS movimientos_count
    FROM base
  )
  SELECT
    (a.ganancia_dropshipper + a.ganancia_proveedor + a.reembolso_flete + a.indemnizacion)::numeric AS total_entradas,
    (a.flete_inicial + a.costo_devolucion + a.comision_referidos + a.mantenimiento_tarjeta + a.orden_sin_recaudo)::numeric AS total_salidas,
    (a.ganancia_dropshipper + a.ganancia_proveedor + a.reembolso_flete + a.indemnizacion
      - a.flete_inicial - a.costo_devolucion - a.comision_referidos - a.mantenimiento_tarjeta - a.orden_sin_recaudo)::numeric AS ganancia_neta,
    a.movimientos_count,
    a.ganancia_dropshipper, a.ganancia_proveedor, a.reembolso_flete, a.indemnizacion,
    a.flete_inicial, a.costo_devolucion, a.comision_referidos, a.mantenimiento_tarjeta, a.orden_sin_recaudo
  FROM agg a;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.wallet_ganancia_neta(timestamptz, timestamptz) TO authenticated;
