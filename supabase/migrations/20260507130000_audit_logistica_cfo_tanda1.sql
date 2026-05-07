-- Audit /logistica + /cfo — Tanda 1 (críticos):
--
-- 1. financial_summary v7 — timezone Bogotá en wallet_range.
--    El v6 filtra `fecha::date BETWEEN p_from AND p_to` sin AT TIME ZONE.
--    El cast ::date sobre timestamptz usa el timezone del servidor (UTC).
--    Movimientos entre 19:00 y 23:59 hora Colombia (00:00-04:59 UTC del día
--    siguiente) caen al día equivocado en el filtro. En un mes son 5-15
--    movimientos mal atribuidos. Cambio: usar (fecha AT TIME ZONE 'Bogota')::date.
--
-- 2. wallet_daily_series — mismo bug. Agrupa por (fecha AT TIME ZONE 'UTC')::date
--    cuando el usuario opera en Colombia. Una entrada del lunes 23:30 Colombia
--    aparece en martes en la serie. Cambio: AT TIME ZONE 'America/Bogota'.
--
-- 3. snapshot_cfo_diagnostico — bug fundamental que Lovable no detectó.
--    financial_summary RETORNA JSONB, no un record. El patrón
--    `SELECT * INTO v_fin RECORD FROM financial_summary(...)` pone el JSONB
--    entero en una sola columna del record, NO desestructura los campos.
--    Acceder `v_fin.ingresos_brutos` busca un campo `ingresos_brutos` en el
--    record que NO existe — silenciosamente devuelve NULL. Resultado: los
--    snapshots mensuales del CFO guardan ingresos/cogs/utilidad_bruta en NULL
--    aunque la función subyacente devuelve datos correctos.
--
--    Fix: declarar v_fin JSONB; y usar SELECT public.financial_summary(...) INTO v_fin
--    + acceso (v_fin->>'campo')::numeric. logistics_summary y wallet_summary
--    SÍ retornan TABLE — esos quedan como están con record.
--
--    También restauro `wallet_neto` (calculado inline como entradas - salidas)
--    y `perdida_devoluciones` (que Lovable removió por accidente).

-- ─────────────────────────────────────────────────────────────────
-- FIX 1 — financial_summary v7 con timezone Bogotá en wallet_range
-- ─────────────────────────────────────────────────────────────────

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
  -- Audit fix: timezone Bogotá. Antes filtraba `fecha::date` con cast
  -- implícito a UTC, perdiendo movimientos de 19:00-23:59 Colombia.
  wallet_range AS (
    SELECT * FROM public.dropi_wallet_movements
    WHERE (fecha AT TIME ZONE 'America/Bogota')::date BETWEEN p_from_date AND p_to_date
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

-- ─────────────────────────────────────────────────────────────────
-- FIX 2 — wallet_daily_series con timezone Bogotá
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.wallet_daily_series(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  fecha    date,
  entrada  numeric,
  salida   numeric
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
  -- Audit fix: agrupar por fecha Bogotá, no UTC. Antes un movimiento del
  -- lunes 23:30 Colombia (= martes 04:30 UTC) aparecía en la serie del martes.
  SELECT
    (m.fecha AT TIME ZONE 'America/Bogota')::date,
    COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.monto ELSE 0 END), 0)::numeric,
    COALESCE(SUM(CASE WHEN m.tipo = 'SALIDA'  THEN m.monto ELSE 0 END), 0)::numeric
  FROM public.dropi_wallet_movements m
  WHERE m.fecha >= p_from AND m.fecha <= p_to
  GROUP BY 1
  ORDER BY 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wallet_daily_series(timestamptz, timestamptz) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- FIX 3 — snapshot_cfo_diagnostico con acceso JSONB correcto a financial_summary
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.snapshot_cfo_diagnostico(p_year_month TEXT)
RETURNS public.cfo_monthly_retrospective
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from_date DATE;
  v_to_date   DATE;
  v_diag      JSONB;
  -- IMPORTANTE: v_fin JSONB (no RECORD). financial_summary retorna JSONB,
  -- no una tabla. Antes era declarado como RECORD y los accesos
  -- v_fin.ingresos_brutos resolvían a NULL silenciosamente — bug fundamental
  -- que dejaba todos los snapshots financieros vacíos.
  v_fin       JSONB;
  v_log       RECORD;
  v_wal       RECORD;
  v_ads_meta  NUMERIC;
  v_ads_tik   NUMERIC;
  v_deuda_usd NUMERIC;
  v_deuda_cop NUMERIC;
  v_row       public.cfo_monthly_retrospective;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  IF p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'year_month inválido' USING ERRCODE = '22023';
  END IF;

  v_from_date := (p_year_month || '-01')::DATE;
  v_to_date   := (v_from_date + INTERVAL '1 month' - INTERVAL '1 day')::DATE;

  -- financial_summary retorna JSONB — captura directamente al variable JSONB.
  BEGIN
    v_fin := public.financial_summary(v_from_date, v_to_date);
  EXCEPTION WHEN OTHERS THEN
    v_fin := NULL;
  END;

  -- logistics_summary y wallet_summary SÍ retornan TABLE. Record es correcto.
  BEGIN
    SELECT * INTO v_log FROM public.logistics_summary(v_from_date, v_to_date);
  EXCEPTION WHEN OTHERS THEN
    v_log := NULL;
  END;

  BEGIN
    SELECT * INTO v_wal FROM public.wallet_summary(v_from_date, v_to_date);
  EXCEPTION WHEN OTHERS THEN
    v_wal := NULL;
  END;

  SELECT
    COALESCE(SUM(amount_cop) FILTER (WHERE platform = 'meta'), 0),
    COALESCE(SUM(amount_cop) FILTER (WHERE platform = 'tiktok'), 0)
    INTO v_ads_meta, v_ads_tik
    FROM public.monthly_ad_spend
   WHERE year_month = p_year_month;

  SELECT saldo_usd, saldo_cop
    INTO v_deuda_usd, v_deuda_cop
    FROM public.tc_debt_snapshots
   WHERE fecha_corte <= v_to_date
   ORDER BY fecha_corte DESC
   LIMIT 1;

  v_diag := jsonb_build_object(
    'year_month',          p_year_month,
    'from_date',           v_from_date,
    'to_date',             v_to_date,
    'snapshot_at',         now(),
    -- Acceso correcto al JSONB devuelto por financial_summary.
    'ingresos',            COALESCE(v_fin->'ingresos_brutos',     'null'::jsonb),
    'cogs',                COALESCE(v_fin->'cogs',                'null'::jsonb),
    'utilidad_bruta',      COALESCE(v_fin->'utilidad_bruta',      'null'::jsonb),
    'flete_entregadas',    COALESCE(v_fin->'flete_entregadas',    'null'::jsonb),
    'perdida_devoluciones',COALESCE(v_fin->'perdida_total_devoluciones', 'null'::jsonb),
    'mantenimiento_tarjeta', COALESCE(v_fin->'mantenimiento_tarjeta', 'null'::jsonb),
    'indemnizaciones',     COALESCE(v_fin->'indemnizaciones',     'null'::jsonb),
    -- logistics_summary + wallet_summary devuelven TABLE — record fields.
    'total_ordenes',       COALESCE(to_jsonb(v_log.total_ordenes),     'null'::jsonb),
    'entregados',          COALESCE(to_jsonb(v_log.entregados),        'null'::jsonb),
    'devueltos',           COALESCE(to_jsonb(v_log.devueltos),         'null'::jsonb),
    'tasa_entrega',        COALESCE(to_jsonb(v_log.tasa_entrega),      'null'::jsonb),
    'tasa_devolucion',     COALESCE(to_jsonb(v_log.tasa_devolucion),   'null'::jsonb),
    'wallet_entradas',     COALESCE(to_jsonb(v_wal.total_entradas),    'null'::jsonb),
    'wallet_salidas',      COALESCE(to_jsonb(v_wal.total_salidas),     'null'::jsonb),
    -- wallet_neto calculado inline (la RPC no lo devuelve; antes Lovable lo dejó NULL).
    'wallet_neto',
      CASE
        WHEN v_wal.total_entradas IS NULL OR v_wal.total_salidas IS NULL
        THEN 'null'::jsonb
        ELSE to_jsonb(v_wal.total_entradas - v_wal.total_salidas)
      END,
    'ads_meta',            v_ads_meta,
    'ads_tiktok',          v_ads_tik,
    'ads_total',           v_ads_meta + v_ads_tik,
    'tc_debt_usd',         COALESCE(to_jsonb(v_deuda_usd), 'null'::jsonb),
    'tc_debt_cop',         COALESCE(to_jsonb(v_deuda_cop), 'null'::jsonb)
  );

  INSERT INTO public.cfo_monthly_retrospective (year_month, diagnostico_auto, diagnostico_at)
  VALUES (p_year_month, v_diag, now())
  ON CONFLICT (year_month) DO UPDATE SET
    diagnostico_auto = EXCLUDED.diagnostico_auto,
    diagnostico_at   = EXCLUDED.diagnostico_at,
    updated_at       = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_cfo_diagnostico(TEXT) TO authenticated;
