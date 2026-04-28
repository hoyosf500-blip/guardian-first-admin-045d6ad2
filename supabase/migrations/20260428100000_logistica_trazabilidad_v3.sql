-- Logística — Trazabilidad v3
--
-- Fix de logic: la v2 no contaba NOVEDAD ni INTENTO DE ENTREGA en
-- ningún bucket → 151 pedidos del periodo de 30 días (~20%) se perdían
-- silenciosamente entre `total_pedidos` y la suma de
-- (entregados + en_transito + devueltos).
--
-- v3 añade:
--   • novedades             — COUNT estados NOVEDAD/INTENTO DE ENTREGA/NOVEDAD SOLUCIONADA
--   • valor_novedades       — SUM(valor) de esos estados
--
-- Con eso, la fórmula correcta del frontend es:
--   despachadas_reales = entregados + en_transito + devueltos + novedades
--   total_entrados     = total_pedidos + cancelados
--   tasa_despacho      = despachadas_reales / total_entrados * 100
--   tasa_cancelacion   = cancelados / total_entrados * 100
--
-- Aplicar con `supabase db push`. Idempotente (DROP + CREATE).

DROP FUNCTION IF EXISTS public.logistics_summary(DATE, DATE);

CREATE OR REPLACE FUNCTION public.logistics_summary(
  p_from_date DATE,
  p_to_date   DATE
)
RETURNS TABLE (
  total_pedidos             BIGINT,
  entregados                BIGINT,
  devueltos                 BIGINT,
  en_transito               BIGINT,
  tasa_entrega              NUMERIC,
  tasa_devolucion           NUMERIC,
  valor_entregado           NUMERIC,
  valor_perdido             NUMERIC,
  valor_en_transito         NUMERIC,
  pendientes_sin_despachar  BIGINT,
  pendientes_por_confirmar  BIGINT,
  valor_pendientes          NUMERIC,
  cancelados                BIGINT,
  valor_cancelado           NUMERIC,
  -- v3: novedades para que la suma cuadre
  novedades                 BIGINT,
  valor_novedades           NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH all_orders AS (
    SELECT estado, valor
    FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
  )
  SELECT
    -- total_pedidos = activos (excluye CANCELADO) — convención v1/v2
    COUNT(*) FILTER (WHERE UPPER(estado) <> 'CANCELADO') AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
       'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
       'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
       'TELEMERCADEO', 'REENVIO', 'REENVÍO',
       'EN BODEGA TRANSPORTADORA', 'ADMITIDA',
       'EN BODEGA DROPI', 'RECOGIDO POR DROPI')) AS en_transito,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*) FILTER (WHERE UPPER(estado) <> 'CANCELADO'), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*) FILTER (WHERE UPPER(estado) <> 'CANCELADO'), 0),
      2
    ) AS tasa_devolucion,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
       'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
       'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
       'TELEMERCADEO', 'REENVIO', 'REENVÍO',
       'EN BODEGA TRANSPORTADORA', 'ADMITIDA',
       'EN BODEGA DROPI', 'RECOGIDO POR DROPI')), 0) AS valor_en_transito,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'PENDIENTE') AS pendientes_sin_despachar,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'PENDIENTE CONFIRMACION') AS pendientes_por_confirmar,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('PENDIENTE', 'PENDIENTE CONFIRMACION')), 0) AS valor_pendientes,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'CANCELADO') AS cancelados,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'CANCELADO'), 0) AS valor_cancelado,
    -- v3: novedades + intento de entrega + novedad solucionada
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('NOVEDAD', 'INTENTO DE ENTREGA', 'NOVEDAD SOLUCIONADA')) AS novedades,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('NOVEDAD', 'INTENTO DE ENTREGA', 'NOVEDAD SOLUCIONADA')), 0) AS valor_novedades
  FROM all_orders;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_summary(DATE, DATE) TO authenticated;
