-- /cfo → "Bitácora mensual"
--
-- Una fila por mes con la retrospectiva escrita + un snapshot inamovible
-- de los números clave al cierre. Sirve para documentar mes a mes el por
-- qué se ganó/perdió plata y no repetir errores.
--
-- Estructura de los campos:
--   fugas       — TEXT[] de "qué quemó plata" (ej. "FB USD sin ROAS").
--   aciertos    — TEXT[] de "qué funcionó bien".
--   lecciones   — narrativa libre (markdown corto).
--   decisiones  — JSONB array con [{accion, deadline, status}] donde status
--                 ∈ (pendiente, hecho, abandonado). Sirve para chequear el
--                 mes siguiente cuáles cumpliste.
--   diagnostico_auto — JSONB con snapshot de RPCs al momento de cerrar:
--                 ingresos, pauta, deuda, tasa_entrega, etc. Se llena con
--                 `snapshot_cfo_diagnostico(p_year_month)` y queda
--                 CONGELADO ahí — no se recalcula al re-abrir.
--   notas       — texto libre extra.

CREATE TABLE IF NOT EXISTS public.cfo_monthly_retrospective (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year_month        TEXT NOT NULL UNIQUE
                    CHECK (year_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fugas             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  aciertos          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  lecciones         TEXT,
  decisiones        JSONB NOT NULL DEFAULT '[]'::JSONB,
  diagnostico_auto  JSONB,
  diagnostico_at    TIMESTAMPTZ,
  notas             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_monthly_retrospective_ym_idx
  ON public.cfo_monthly_retrospective (year_month DESC);

-- ─────────────────────────────────────────────────────────────────
-- RLS — admin-only.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.cfo_monthly_retrospective ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cfo_retro_admin_select" ON public.cfo_monthly_retrospective;
CREATE POLICY "cfo_retro_admin_select"
  ON public.cfo_monthly_retrospective
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "cfo_retro_admin_insert" ON public.cfo_monthly_retrospective;
CREATE POLICY "cfo_retro_admin_insert"
  ON public.cfo_monthly_retrospective
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "cfo_retro_admin_update" ON public.cfo_monthly_retrospective;
CREATE POLICY "cfo_retro_admin_update"
  ON public.cfo_monthly_retrospective
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "cfo_retro_admin_delete" ON public.cfo_monthly_retrospective;
CREATE POLICY "cfo_retro_admin_delete"
  ON public.cfo_monthly_retrospective
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ─────────────────────────────────────────────────────────────────
-- Trigger updated_at.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_cfo_retrospective_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cfo_retrospective_updated_at_trg
  ON public.cfo_monthly_retrospective;
CREATE TRIGGER cfo_retrospective_updated_at_trg
  BEFORE UPDATE ON public.cfo_monthly_retrospective
  FOR EACH ROW EXECUTE FUNCTION public.tg_cfo_retrospective_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- RPC list — todas las retrospectivas (orden desc por mes).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_cfo_retrospectives()
RETURNS SETOF public.cfo_monthly_retrospective
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT * FROM public.cfo_monthly_retrospective
   ORDER BY year_month DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_cfo_retrospectives() TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC get — una sola retrospectiva por mes.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_cfo_retrospective(p_year_month TEXT)
RETURNS public.cfo_monthly_retrospective
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.cfo_monthly_retrospective;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM public.cfo_monthly_retrospective
   WHERE year_month = p_year_month;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cfo_retrospective(TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC upsert — crea o actualiza la retrospectiva del mes (no toca el
-- diagnóstico auto, eso lo maneja `snapshot_cfo_diagnostico`).
--
-- Pasamos arrays como JSONB para evitar problemas de tipo entre
-- PostgREST y arrays nativos.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_cfo_retrospective(
  p_year_month  TEXT,
  p_fugas       JSONB,
  p_aciertos    JSONB,
  p_lecciones   TEXT,
  p_decisiones  JSONB,
  p_notas       TEXT
)
RETURNS public.cfo_monthly_retrospective
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row      public.cfo_monthly_retrospective;
  v_fugas    TEXT[];
  v_aciertos TEXT[];
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  IF p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'year_month inválido (esperado YYYY-MM)' USING ERRCODE = '22023';
  END IF;

  IF p_fugas IS NULL OR jsonb_typeof(p_fugas) <> 'array' THEN
    v_fugas := ARRAY[]::TEXT[];
  ELSE
    SELECT COALESCE(array_agg(value::TEXT), ARRAY[]::TEXT[])
      INTO v_fugas
      FROM jsonb_array_elements_text(p_fugas) AS t(value);
  END IF;

  IF p_aciertos IS NULL OR jsonb_typeof(p_aciertos) <> 'array' THEN
    v_aciertos := ARRAY[]::TEXT[];
  ELSE
    SELECT COALESCE(array_agg(value::TEXT), ARRAY[]::TEXT[])
      INTO v_aciertos
      FROM jsonb_array_elements_text(p_aciertos) AS t(value);
  END IF;

  INSERT INTO public.cfo_monthly_retrospective (
    year_month, fugas, aciertos, lecciones, decisiones, notas
  ) VALUES (
    p_year_month,
    v_fugas,
    v_aciertos,
    NULLIF(p_lecciones, ''),
    COALESCE(p_decisiones, '[]'::JSONB),
    NULLIF(p_notas, '')
  )
  ON CONFLICT (year_month) DO UPDATE SET
    fugas      = EXCLUDED.fugas,
    aciertos   = EXCLUDED.aciertos,
    lecciones  = EXCLUDED.lecciones,
    decisiones = EXCLUDED.decisiones,
    notas      = EXCLUDED.notas
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_cfo_retrospective(TEXT, JSONB, JSONB, TEXT, JSONB, TEXT)
  TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC snapshot_cfo_diagnostico — congela los números clave del mes.
-- Idempotente: al re-llamar reemplaza el snapshot anterior.
--
-- Calcula:
--   - Rango fechas del mes.
--   - financial_summary → ingresos / cogs / utilidad bruta / etc.
--   - logistics_summary → entregados / devueltos / tasas
--   - wallet_summary    → entradas / salidas / neto
--   - SUM monthly_ad_spend → meta + tiktok
--   - tc_debt_snapshots ≤ fin del mes → deuda al cierre
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
  v_fin       RECORD;
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

  BEGIN
    SELECT * INTO v_fin FROM public.financial_summary(v_from_date, v_to_date);
  EXCEPTION WHEN OTHERS THEN
    v_fin := NULL;
  END;

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

  SELECT total_usd, total_cop
    INTO v_deuda_usd, v_deuda_cop
    FROM public.tc_debt_snapshots
   WHERE snapshot_date <= v_to_date
   ORDER BY snapshot_date DESC
   LIMIT 1;

  v_diag := jsonb_build_object(
    'year_month',          p_year_month,
    'from_date',           v_from_date,
    'to_date',             v_to_date,
    'snapshot_at',         now(),
    'ingresos',            COALESCE(to_jsonb(v_fin.ingresos), 'null'::jsonb),
    'cogs',                COALESCE(to_jsonb(v_fin.cogs), 'null'::jsonb),
    'utilidad_bruta',      COALESCE(to_jsonb(v_fin.utilidad_bruta), 'null'::jsonb),
    'flete_entregadas',    COALESCE(to_jsonb(v_fin.flete_entregadas), 'null'::jsonb),
    'perdida_devoluciones',COALESCE(to_jsonb(v_fin.perdida_devoluciones), 'null'::jsonb),
    'total_ordenes',       COALESCE(to_jsonb(v_log.total_ordenes), 'null'::jsonb),
    'entregados',          COALESCE(to_jsonb(v_log.entregados), 'null'::jsonb),
    'devueltos',           COALESCE(to_jsonb(v_log.devueltos), 'null'::jsonb),
    'tasa_entrega',        COALESCE(to_jsonb(v_log.tasa_entrega), 'null'::jsonb),
    'tasa_devolucion',     COALESCE(to_jsonb(v_log.tasa_devolucion), 'null'::jsonb),
    'wallet_entradas',     COALESCE(to_jsonb(v_wal.total_entradas), 'null'::jsonb),
    'wallet_salidas',      COALESCE(to_jsonb(v_wal.total_salidas), 'null'::jsonb),
    'wallet_neto',         COALESCE(to_jsonb(v_wal.neto), 'null'::jsonb),
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
    diagnostico_at   = EXCLUDED.diagnostico_at
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_cfo_diagnostico(TEXT) TO authenticated;
