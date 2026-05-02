-- v6: agrega métricas claras de devoluciones que el cliente pide:
--   - perdida_total_devoluciones = flete_devoluciones + costo_devoluciones
--     (pérdida REAL — incluye flete de ida no reembolsado + cargo extra Dropi)
--   - costo_promedio_devolucion = perdida_total / total_devueltas
--
-- También agrega métricas nuevas que ahora vienen de wallet bien categorizada:
--   - mantenimiento_tarjeta (gasto mensual)
--   - indemnizaciones (ingreso ocasional)
--
-- Aplicar con `supabase db push`. CREATE OR REPLACE — idempotente.

CREATE OR REPLACE FUNCTION public.financial_summary(
  p_from_date DATE,
  p_to_date   DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  WITH
  filtered AS (
    SELECT * FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
  ),
  entregados AS (
    SELECT * FROM filtered WHERE UPPER(COALESCE(estado, '')) LIKE 'ENTREGAD%'
  ),
  devueltos AS (
    SELECT * FROM filtered
    WHERE UPPER(COALESCE(estado, '')) LIKE 'DEVOLUC%'
       OR UPPER(COALESCE(estado, '')) LIKE 'DEVUELT%'
       OR UPPER(COALESCE(estado, '')) = 'RECHAZADO'
  ),
  cancelados AS (
    SELECT * FROM filtered
    WHERE UPPER(COALESCE(estado, '')) LIKE '%CANCEL%'
  ),
  wallet_range AS (
    SELECT * FROM public.dropi_wallet_movements
    WHERE fecha::date BETWEEN p_from_date AND p_to_date
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
      COALESCE((SELECT AVG(valor) FROM entregados), 0) AS avg_ticket,
      COALESCE((SELECT SUM(
        CASE WHEN tipo = 'ENTRADA' THEN monto ELSE -monto END
      ) FROM wallet_range), 0) AS wallet_neto
  ),
  agg_calc AS (
    SELECT
      a.*,
      -- Pérdida total real = flete de ida no reembolsado + cargo extra Dropi
      a.flete_devoluciones + a.cargo_extra_devoluciones AS perdida_total_devoluciones,
      -- Costo promedio por devolución (NULL-safe: si no hay devs, 0)
      CASE WHEN a.total_devueltas > 0
        THEN ROUND((a.flete_devoluciones + a.cargo_extra_devoluciones)::numeric / a.total_devueltas, 0)
        ELSE 0
      END AS costo_promedio_devolucion
    FROM agg a
  )
  SELECT jsonb_build_object(
    -- Métricas existentes
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
    -- NUEVO: el viejo "costo_devoluciones" ahora se llama "cargo_extra_devoluciones"
    -- pero mantenemos el alias para back-compat con el front actual:
    'costo_devoluciones',  a.cargo_extra_devoluciones,
    -- NUEVO: pérdida total real por devoluciones (lo que el cliente pidió)
    'perdida_total_devoluciones', a.perdida_total_devoluciones,
    'costo_promedio_devolucion',  a.costo_promedio_devolucion,
    -- NUEVO: gastos/ingresos varios de wallet
    'mantenimiento_tarjeta',      a.mantenimiento_tarjeta,
    'indemnizaciones',            a.indemnizaciones,
    -- Utilidad bruta = ingresos - cogs - flete_entregadas - perdida_total_devoluciones
    --                  - comision_referidos - mantenimiento_tarjeta + indemnizaciones
    -- (NO suma ganancia_markup hasta confirmar sanity check; NO incluye gasto pauta — Fase B)
    'utilidad_bruta',
        a.ingresos_brutos
      - a.cogs
      - a.flete_entregadas
      - a.perdida_total_devoluciones
      - a.comision_referidos
      - a.mantenimiento_tarjeta
      + a.indemnizaciones,
    'total_ordenes',       a.total_ordenes,
    'total_entregadas',    a.total_entregadas,
    'total_devueltas',     a.total_devueltas,
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
$func$;

REVOKE ALL ON FUNCTION public.financial_summary(DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_summary(DATE, DATE) TO authenticated;
