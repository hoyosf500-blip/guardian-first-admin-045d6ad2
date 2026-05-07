-- H2: admin gate en upsert_wallet_movements
CREATE OR REPLACE FUNCTION public.upsert_wallet_movements(p_movements jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE v_changed integer;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;
  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset(p_movements) AS x(
      dropi_transaction_id BIGINT, fecha TIMESTAMPTZ, tipo TEXT, codigo TEXT,
      categoria TEXT, monto NUMERIC, monto_previo NUMERIC, saldo_despues NUMERIC,
      descripcion TEXT, cuenta TEXT, concepto_retiro TEXT, related_order_id TEXT,
      raw JSONB, synced_by UUID
    )
  ),
  upserted AS (
    INSERT INTO public.dropi_wallet_movements (
      dropi_transaction_id, fecha, tipo, codigo, categoria, monto,
      monto_previo, saldo_despues, descripcion, cuenta, concepto_retiro,
      related_order_id, raw, synced_by
    )
    SELECT dropi_transaction_id, fecha, tipo, codigo, categoria, monto,
      monto_previo, saldo_despues, descripcion, cuenta, concepto_retiro,
      related_order_id, raw, synced_by FROM input_rows
    ON CONFLICT (dropi_transaction_id) DO UPDATE SET
      tipo=EXCLUDED.tipo, codigo=EXCLUDED.codigo, categoria=EXCLUDED.categoria,
      monto=EXCLUDED.monto, monto_previo=EXCLUDED.monto_previo,
      saldo_despues=EXCLUDED.saldo_despues, descripcion=EXCLUDED.descripcion,
      cuenta=EXCLUDED.cuenta, concepto_retiro=EXCLUDED.concepto_retiro,
      related_order_id=EXCLUDED.related_order_id, raw=EXCLUDED.raw, synced_at=now()
    WHERE dropi_wallet_movements.tipo IS DISTINCT FROM EXCLUDED.tipo
       OR dropi_wallet_movements.codigo IS DISTINCT FROM EXCLUDED.codigo
       OR dropi_wallet_movements.monto IS DISTINCT FROM EXCLUDED.monto
       OR dropi_wallet_movements.monto_previo IS DISTINCT FROM EXCLUDED.monto_previo
       OR dropi_wallet_movements.descripcion IS DISTINCT FROM EXCLUDED.descripcion
       OR dropi_wallet_movements.related_order_id IS DISTINCT FROM EXCLUDED.related_order_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM upserted;
  RETURN COALESCE(v_changed, 0);
END; $func$;

CREATE OR REPLACE FUNCTION public.protect_fecha_conf_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.fecha_conf IS NOT NULL AND OLD.fecha_conf <> '' THEN
    NEW.fecha_conf := OLD.fecha_conf;
    IF OLD.fecha_conf ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      NEW.dias_conf := GREATEST(0, (CURRENT_DATE - OLD.fecha_conf::date));
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_orphan_pending_orders()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.orders viejo
  SET estado = 'CANCELADO'
  WHERE viejo.estado = 'PENDIENTE CONFIRMACION'
    AND viejo.created_at > NOW() - INTERVAL '7 days'
    AND EXISTS (
      SELECT 1 FROM public.orders nuevo
      WHERE nuevo.phone = viejo.phone AND nuevo.producto = viejo.producto
        AND nuevo.id != viejo.id
        AND nuevo.estado IN ('ENTREGADO', 'DEVOLUCION', 'DEVOLUCION EN TRANSITO')
        AND nuevo.created_at > viejo.created_at
        AND nuevo.created_at < viejo.created_at + INTERVAL '48 hours'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

CREATE OR REPLACE FUNCTION public.snapshot_cfo_diagnostico(p_year_month TEXT)
RETURNS public.cfo_monthly_retrospective
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from_date DATE; v_to_date DATE; v_diag JSONB;
  v_fin RECORD; v_log RECORD; v_wal RECORD;
  v_ads_meta NUMERIC; v_ads_tik NUMERIC;
  v_deuda_usd NUMERIC; v_deuda_cop NUMERIC;
  v_row public.cfo_monthly_retrospective;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;
  IF p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'year_month inválido' USING ERRCODE = '22023';
  END IF;
  v_from_date := (p_year_month || '-01')::DATE;
  v_to_date := (v_from_date + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
  BEGIN SELECT * INTO v_fin FROM public.financial_summary(v_from_date, v_to_date);
  EXCEPTION WHEN OTHERS THEN v_fin := NULL; END;
  BEGIN SELECT * INTO v_log FROM public.logistics_summary(v_from_date, v_to_date);
  EXCEPTION WHEN OTHERS THEN v_log := NULL; END;
  BEGIN SELECT * INTO v_wal FROM public.wallet_summary(v_from_date, v_to_date);
  EXCEPTION WHEN OTHERS THEN v_wal := NULL; END;
  SELECT COALESCE(SUM(amount_cop) FILTER (WHERE platform = 'meta'), 0),
         COALESCE(SUM(amount_cop) FILTER (WHERE platform = 'tiktok'), 0)
    INTO v_ads_meta, v_ads_tik
    FROM public.monthly_ad_spend WHERE year_month = p_year_month;
  -- Audit M1: columnas reales son saldo_usd/saldo_cop/fecha_corte
  SELECT saldo_usd, saldo_cop INTO v_deuda_usd, v_deuda_cop
    FROM public.tc_debt_snapshots
   WHERE fecha_corte <= v_to_date
   ORDER BY fecha_corte DESC LIMIT 1;
  v_diag := jsonb_build_object(
    'year_month', p_year_month, 'from_date', v_from_date, 'to_date', v_to_date,
    'snapshot_at', now(),
    'ingresos', COALESCE(to_jsonb(v_fin.ingresos_brutos), 'null'::jsonb),
    'cogs', COALESCE(to_jsonb(v_fin.cogs), 'null'::jsonb),
    'utilidad_bruta', COALESCE(to_jsonb(v_fin.utilidad_bruta), 'null'::jsonb),
    'flete_entregadas', COALESCE(to_jsonb(v_fin.flete_entregadas), 'null'::jsonb),
    'total_ordenes', COALESCE(to_jsonb(v_log.total_ordenes), 'null'::jsonb),
    'entregados', COALESCE(to_jsonb(v_log.entregados), 'null'::jsonb),
    'devueltos', COALESCE(to_jsonb(v_log.devueltos), 'null'::jsonb),
    'tasa_entrega', COALESCE(to_jsonb(v_log.tasa_entrega), 'null'::jsonb),
    'tasa_devolucion', COALESCE(to_jsonb(v_log.tasa_devolucion), 'null'::jsonb),
    'wallet_entradas', COALESCE(to_jsonb(v_wal.total_entradas), 'null'::jsonb),
    'wallet_salidas', COALESCE(to_jsonb(v_wal.total_salidas), 'null'::jsonb),
    'ads_meta', v_ads_meta, 'ads_tiktok', v_ads_tik,
    'ads_total', v_ads_meta + v_ads_tik,
    'tc_debt_usd', COALESCE(to_jsonb(v_deuda_usd), 'null'::jsonb),
    'tc_debt_cop', COALESCE(to_jsonb(v_deuda_cop), 'null'::jsonb)
  );
  INSERT INTO public.cfo_monthly_retrospective (year_month, diagnostico_auto, diagnostico_at)
  VALUES (p_year_month, v_diag, now())
  ON CONFLICT (year_month) DO UPDATE SET
    diagnostico_auto = EXCLUDED.diagnostico_auto,
    diagnostico_at = EXCLUDED.diagnostico_at
  RETURNING * INTO v_row;
  RETURN v_row;
END; $$;