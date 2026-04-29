-- Sync del Historial de Cartera de Dropi (api/historywallet)
--
-- Almacena cada movimiento de la billetera (SALIDA / ENTRADA) con backup
-- del payload original en `raw` para poder re-mapear si Dropi cambia el
-- shape sin tener que re-sincronizar.
--
-- Endpoint en Dropi: GET https://api.dropi.co/api/historywallet
-- Auth: x-authorization: Bearer <dropi_session_token>  (NO la integration-key;
--       ese namespace /integrations/* no expone wallet — confirmado con probes
--       HTTP 404 en Fase 0 del 2026-04-29).
--
-- Patrón idéntico a upsert_orders_from_dropi: ON CONFLICT DO UPDATE WHERE
-- IS DISTINCT FROM para no disparar realtime espurio cuando re-sincronizamos
-- y nada cambió.

CREATE TABLE IF NOT EXISTS public.dropi_wallet_movements (
  id                    BIGSERIAL PRIMARY KEY,
  dropi_transaction_id  BIGINT      NOT NULL UNIQUE,   -- 193272742
  fecha                 TIMESTAMPTZ NOT NULL,          -- created_at del movimiento
  tipo                  TEXT        NOT NULL,          -- 'SALIDA' | 'ENTRADA'
  codigo                TEXT,                           -- 'SALIDA POR COBRO DE FLETE INICIAL', etc.
  categoria             TEXT,                           -- mapeo interno: 'flete_inicial', 'cobro_entrega', 'costo_devolucion', ...
  monto                 NUMERIC     NOT NULL,           -- magnitud (siempre positiva); el signo lo da `tipo`
  monto_previo          NUMERIC,                        -- saldo antes del movimiento (lo da Dropi)
  saldo_despues         NUMERIC,                        -- saldo después (calculado en el edge function)
  descripcion           TEXT,
  cuenta                TEXT,
  concepto_retiro       TEXT,
  related_order_id      TEXT,                           -- extraído del final de descripcion (": 71014957")
  raw                   JSONB       NOT NULL,           -- payload completo de Dropi
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_by             UUID        REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS dropi_wallet_fecha_idx
  ON public.dropi_wallet_movements (fecha DESC);
CREATE INDEX IF NOT EXISTS dropi_wallet_categoria_idx
  ON public.dropi_wallet_movements (categoria);
CREATE INDEX IF NOT EXISTS dropi_wallet_tipo_fecha_idx
  ON public.dropi_wallet_movements (tipo, fecha DESC);
CREATE INDEX IF NOT EXISTS dropi_wallet_related_order_idx
  ON public.dropi_wallet_movements (related_order_id)
  WHERE related_order_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- RLS — admin-only (datos financieros sensibles, no para operadoras)
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.dropi_wallet_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wallet_admin_select" ON public.dropi_wallet_movements;
CREATE POLICY "wallet_admin_select"
  ON public.dropi_wallet_movements
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- INSERT/UPDATE solo vía RPC (que corre como SECURITY DEFINER). Cerramos
-- escritura directa desde authenticated para que nadie pueda inyectar
-- movimientos falsos manualmente.
DROP POLICY IF EXISTS "wallet_no_direct_write" ON public.dropi_wallet_movements;
CREATE POLICY "wallet_no_direct_write"
  ON public.dropi_wallet_movements
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- ─────────────────────────────────────────────────────────────────
-- RPC upsert_wallet_movements — idempotente, mismo patrón que
-- upsert_orders_from_dropi. Devuelve cantidad de filas que cambiaron.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_wallet_movements(p_movements jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_changed integer;
BEGIN
  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset(p_movements) AS x(
      dropi_transaction_id BIGINT,
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
      dropi_transaction_id, fecha, tipo, codigo, categoria, monto,
      monto_previo, saldo_despues, descripcion, cuenta, concepto_retiro,
      related_order_id, raw, synced_by
    )
    SELECT
      dropi_transaction_id, fecha, tipo, codigo, categoria, monto,
      monto_previo, saldo_despues, descripcion, cuenta, concepto_retiro,
      related_order_id, raw, synced_by
    FROM input_rows
    ON CONFLICT (dropi_transaction_id) DO UPDATE SET
      tipo             = EXCLUDED.tipo,
      codigo           = EXCLUDED.codigo,
      categoria        = EXCLUDED.categoria,
      monto            = EXCLUDED.monto,
      monto_previo     = EXCLUDED.monto_previo,
      saldo_despues    = EXCLUDED.saldo_despues,
      descripcion      = EXCLUDED.descripcion,
      cuenta           = EXCLUDED.cuenta,
      concepto_retiro  = EXCLUDED.concepto_retiro,
      related_order_id = EXCLUDED.related_order_id,
      raw              = EXCLUDED.raw,
      synced_at        = now()
    WHERE
      dropi_wallet_movements.tipo             IS DISTINCT FROM EXCLUDED.tipo
      OR dropi_wallet_movements.codigo           IS DISTINCT FROM EXCLUDED.codigo
      OR dropi_wallet_movements.monto            IS DISTINCT FROM EXCLUDED.monto
      OR dropi_wallet_movements.monto_previo     IS DISTINCT FROM EXCLUDED.monto_previo
      OR dropi_wallet_movements.descripcion      IS DISTINCT FROM EXCLUDED.descripcion
      OR dropi_wallet_movements.related_order_id IS DISTINCT FROM EXCLUDED.related_order_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM upserted;

  RETURN COALESCE(v_changed, 0);
END;
$func$;

REVOKE ALL ON FUNCTION public.upsert_wallet_movements(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_wallet_movements(jsonb) TO authenticated, service_role;

COMMENT ON TABLE public.dropi_wallet_movements IS
  'Historial de billetera Dropi sincronizado desde GET /api/historywallet. RLS admin-only.';

COMMENT ON FUNCTION public.upsert_wallet_movements(jsonb) IS
  'Bulk upsert idempotente para dropi-wallet-sync. WHERE IS DISTINCT FROM evita realtime spam.';
