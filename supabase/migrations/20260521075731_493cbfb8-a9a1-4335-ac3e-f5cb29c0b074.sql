-- Multi-tienda SP3: upsert_wallet_movements ahora propaga store_id por movimiento.
-- Sin esto, todos los movimientos quedaban bajo el store por defecto
-- ('00000000-...0001' = Colombia) aunque vinieran de la wallet de Ecuador.
--
-- Cambios:
--   1. Agrega columna store_id UUID al recordset de entrada.
--   2. Inserta store_id (con fallback al default si el caller no manda).
--   3. Reemplaza el gate "admin-only" puro (que rompía cuando se llama
--      desde service role sin auth.uid) por uno permisivo para
--      service_role y restrictivo para usuarios autenticados (admin O
--      dueño de la tienda enviada en el batch). Las edge functions
--      siguen haciendo el gate de auth por su cuenta antes de invocar.

CREATE OR REPLACE FUNCTION public.upsert_wallet_movements(p_movements jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_changed integer;
  v_uid uuid := auth.uid();
  v_store_ids uuid[];
BEGIN
  -- Permitir service_role (auth.uid IS NULL) sin chequeo extra: el edge
  -- function es responsable de validar al caller. Para usuarios autenticados,
  -- exigir admin global O ser owner de TODAS las tiendas en el batch.
  IF v_uid IS NOT NULL AND NOT public.has_role(v_uid, 'admin') THEN
    SELECT array_agg(DISTINCT (x->>'store_id')::uuid)
      INTO v_store_ids
      FROM jsonb_array_elements(p_movements) AS x
     WHERE (x->>'store_id') IS NOT NULL;
    IF v_store_ids IS NULL OR EXISTS (
      SELECT 1 FROM unnest(v_store_ids) sid
       WHERE NOT public.is_store_owner(sid)
    ) THEN
      RAISE EXCEPTION 'No autorizado para esta tienda' USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset(p_movements) AS x(
      dropi_transaction_id BIGINT,
      store_id             UUID,
      fecha                TIMESTAMPTZ,
      tipo                 TEXT,
      codigo               TEXT,
      categoria            TEXT,
      monto                NUMERIC,
      monto_previo         NUMERIC,
      saldo_despues        NUMERIC,
      descripcion          TEXT,
      cuenta               TEXT,
      concepto_retiro      TEXT,
      related_order_id     TEXT,
      raw                  JSONB,
      synced_by            UUID
    )
  ),
  upserted AS (
    INSERT INTO public.dropi_wallet_movements (
      dropi_transaction_id, store_id, fecha, tipo, codigo, categoria, monto,
      monto_previo, saldo_despues, descripcion, cuenta, concepto_retiro,
      related_order_id, raw, synced_by
    )
    SELECT
      dropi_transaction_id,
      COALESCE(store_id, '00000000-0000-0000-0000-000000000001'::uuid),
      fecha, tipo, codigo, categoria, monto,
      monto_previo, saldo_despues, descripcion, cuenta, concepto_retiro,
      related_order_id, raw, synced_by
    FROM input_rows
    ON CONFLICT (dropi_transaction_id) DO UPDATE SET
      tipo            = EXCLUDED.tipo,
      codigo          = EXCLUDED.codigo,
      categoria       = EXCLUDED.categoria,
      monto           = EXCLUDED.monto,
      monto_previo    = EXCLUDED.monto_previo,
      saldo_despues   = EXCLUDED.saldo_despues,
      descripcion     = EXCLUDED.descripcion,
      cuenta          = EXCLUDED.cuenta,
      concepto_retiro = EXCLUDED.concepto_retiro,
      related_order_id= EXCLUDED.related_order_id,
      raw             = EXCLUDED.raw,
      synced_at       = now()
      -- store_id NO se actualiza: el origen del movimiento es inmutable.
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
END;
$func$;

REVOKE ALL ON FUNCTION public.upsert_wallet_movements(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_wallet_movements(jsonb) TO authenticated, service_role;