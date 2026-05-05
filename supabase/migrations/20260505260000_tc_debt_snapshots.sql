-- /cfo "Cómo voy" — tracker de deuda de tarjetas de crédito.
-- Fabian quiere ver progreso de la deuda mes a mes con barra estilo
-- "cuánto debo, cuánto pagué, cuánto falta". Cada extracto/corte se
-- guarda como un snapshot. Admin-only.
--
-- Tabla: tc_debt_snapshots (snapshots por fecha + tarjeta)
--   - tarjeta: 'amex_6109' | 'mc_9999'
--   - fecha_corte: fecha del corte del extracto (DATE)
--   - saldo_cop: deuda en pesos a esa fecha
--   - saldo_usd: deuda en dólares a esa fecha
--   - trm: tasa de cambio del día del corte (para calcular total COP)
--   - cupo_cop: cupo total de la tarjeta en COP
--   - source: 'extracto_pdf' | 'consulta_movimientos' | 'manual' | 'banco_app'
--   - notas: observaciones del corte (ej: "pagué $10M, sigue alta porque
--            el orden de prelación tocó nacional, no USD")

CREATE TABLE IF NOT EXISTS public.tc_debt_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tarjeta       TEXT NOT NULL CHECK (tarjeta IN ('amex_6109', 'mc_9999')),
  fecha_corte   DATE NOT NULL,
  saldo_cop     NUMERIC NOT NULL DEFAULT 0 CHECK (saldo_cop >= 0),
  saldo_usd     NUMERIC NOT NULL DEFAULT 0 CHECK (saldo_usd >= 0),
  trm           NUMERIC NOT NULL DEFAULT 0 CHECK (trm >= 0),
  cupo_cop      NUMERIC NOT NULL DEFAULT 0 CHECK (cupo_cop >= 0),
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('extracto_pdf', 'consulta_movimientos', 'manual', 'banco_app')),
  notas         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tarjeta, fecha_corte)
);

CREATE INDEX IF NOT EXISTS tc_debt_snapshots_tarjeta_fecha_idx
  ON public.tc_debt_snapshots (tarjeta, fecha_corte DESC);

-- ─────────────────────────────────────────────────────────────────
-- RLS — admin-only (datos financieros sensibles del dueño).
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.tc_debt_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tc_debt_admin_select" ON public.tc_debt_snapshots;
CREATE POLICY "tc_debt_admin_select"
  ON public.tc_debt_snapshots
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "tc_debt_admin_insert" ON public.tc_debt_snapshots;
CREATE POLICY "tc_debt_admin_insert"
  ON public.tc_debt_snapshots
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "tc_debt_admin_update" ON public.tc_debt_snapshots;
CREATE POLICY "tc_debt_admin_update"
  ON public.tc_debt_snapshots
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "tc_debt_admin_delete" ON public.tc_debt_snapshots;
CREATE POLICY "tc_debt_admin_delete"
  ON public.tc_debt_snapshots
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ─────────────────────────────────────────────────────────────────
-- Trigger updated_at — patrón estándar de la app.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_tc_debt_snapshots_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tc_debt_snapshots_updated_at_trg
  ON public.tc_debt_snapshots;
CREATE TRIGGER tc_debt_snapshots_updated_at_trg
  BEFORE UPDATE ON public.tc_debt_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.tg_tc_debt_snapshots_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- RPC upsert — idempotente por (tarjeta, fecha_corte).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_tc_debt_snapshot(
  p_tarjeta     TEXT,
  p_fecha_corte DATE,
  p_saldo_cop   NUMERIC,
  p_saldo_usd   NUMERIC,
  p_trm         NUMERIC,
  p_cupo_cop    NUMERIC,
  p_source      TEXT,
  p_notas       TEXT
)
RETURNS public.tc_debt_snapshots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.tc_debt_snapshots;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.tc_debt_snapshots (
    tarjeta, fecha_corte, saldo_cop, saldo_usd, trm, cupo_cop, source, notas
  ) VALUES (
    p_tarjeta, p_fecha_corte,
    COALESCE(p_saldo_cop, 0),
    COALESCE(p_saldo_usd, 0),
    COALESCE(p_trm, 0),
    COALESCE(p_cupo_cop, 0),
    COALESCE(NULLIF(p_source, ''), 'manual'),
    NULLIF(p_notas, '')
  )
  ON CONFLICT (tarjeta, fecha_corte) DO UPDATE SET
    saldo_cop = EXCLUDED.saldo_cop,
    saldo_usd = EXCLUDED.saldo_usd,
    trm       = EXCLUDED.trm,
    cupo_cop  = EXCLUDED.cupo_cop,
    source    = EXCLUDED.source,
    notas     = EXCLUDED.notas
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_tc_debt_snapshot(TEXT, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT)
  TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- Seeds históricos extraídos de los PDFs Bancolombia Mastercard *9999
-- que Fabian compartió el 5-may-2026. TRM aproximadas (precio de
-- referencia del día del corte, fuente: histórico SuperFinanciera).
-- Cupo total de la tarjeta = $18.500.000 (mismo en todos los cortes).
-- ─────────────────────────────────────────────────────────────────

INSERT INTO public.tc_debt_snapshots
  (tarjeta, fecha_corte, saldo_cop, saldo_usd, trm, cupo_cop, source, notas)
VALUES
  ('mc_9999', '2026-01-15', 295000, 0, 4150, 18500000, 'extracto_pdf',
   'Corte 29-dic→15-ene. Solo $295K (1 transacción Almacen Pulido a 2 cuotas). Tasa 24.33% EA. Cero USD.'),
  ('mc_9999', '2026-02-15', 4682, 2598, 4040, 18500000, 'extracto_pdf',
   'Corte 15-ene→15-feb. Pagó $1.917.330 → barrió COP. Pero arrancó USD ($2.598 en Meta Ads, todo a 36 cuotas, 25.19% EA). Compras COP del mes: $1.622.330 (TODO PERSONAL: Sazoma, Súper, Avianca, Pub La Pinta, Dollarcity).'),
  ('mc_9999', '2026-03-15', 3772414, 2009, 3920, 18500000, 'extracto_pdf',
   'Corte 15-feb→15-mar. EXPLOTÓ COP ($3.77M). Compras del mes $3.012.707 (PERSONAL: Yire $634K + Bold Thezonashop $510K + Bold Fracol $300K + HYM Jardín $225K + ...) + AVANCE $750K a 24 cuotas 25.5% EA. USD: pagó $6.024 el 6-mar (canceló USD viejas, todas a 36/36 saldo $0) PERO cargó $5.457 NUEVAS de Meta = bola de nieve. Tasa subió a 25.50% EA.'),
  ('mc_9999', '2026-05-05', 1636343, 6934, 3707.58, 18500000, 'manual',
   'Snapshot HOY (no es fecha de corte oficial, es estado actual). Pagó $10M el 15-abr → cubrió COP del corte 15-mar pero el orden de prelación de Bancolombia (nacional 1 cuota → nacional diferido → internacional) hizo que el USD ni se moviera. USD creció de $2.009 → $6.934 entre 15-mar y hoy = $4.925 más en cargos Meta (~$18.2M COP) que entraron a 36 cuotas 25.50% EA.')
ON CONFLICT (tarjeta, fecha_corte) DO UPDATE SET
  saldo_cop = EXCLUDED.saldo_cop,
  saldo_usd = EXCLUDED.saldo_usd,
  trm       = EXCLUDED.trm,
  cupo_cop  = EXCLUDED.cupo_cop,
  source    = EXCLUDED.source,
  notas     = EXCLUDED.notas;

-- Snapshot HOY de Amex *6109 (dato del usuario, sin extractos PDF aún).
INSERT INTO public.tc_debt_snapshots
  (tarjeta, fecha_corte, saldo_cop, saldo_usd, trm, cupo_cop, source, notas)
VALUES
  ('amex_6109', '2026-05-05', 8063401, 114, 3707.58, 0, 'manual',
   'Snapshot HOY (cupo total desconocido aún). Total $8.486.065 según user. Esperando extractos PDF para reconstruir histórico.')
ON CONFLICT (tarjeta, fecha_corte) DO UPDATE SET
  saldo_cop = EXCLUDED.saldo_cop,
  saldo_usd = EXCLUDED.saldo_usd,
  trm       = EXCLUDED.trm,
  cupo_cop  = EXCLUDED.cupo_cop,
  source    = EXCLUDED.source,
  notas     = EXCLUDED.notas;
