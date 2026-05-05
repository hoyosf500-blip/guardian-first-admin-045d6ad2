-- /cfo (panel "Cómo voy") — vista del dueño Fabian, admin-only.
-- Inputs manuales mensuales que NO viven en Dropi: gasto pauta, pagos
-- a tarjeta de crédito, intereses. Combinados con financial_summary y
-- wallet_summary dan la utilidad NETA REAL del negocio.
--
-- Tabla: monthly_business_inputs (1 row por mes, key = year_month).
-- Setting: costos_fijos_mensuales (nómina + socio + apps, default 3,080,000).

CREATE TABLE IF NOT EXISTS public.monthly_business_inputs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Formato 'YYYY-MM' — un row por mes. UNIQUE para upsert por
  -- (year_month) y CHECK para evitar valores tipo "abril 2026" o "2026-4".
  year_month      TEXT UNIQUE NOT NULL CHECK (year_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  ads_meta        NUMERIC NOT NULL DEFAULT 0 CHECK (ads_meta >= 0),
  ads_tiktok      NUMERIC NOT NULL DEFAULT 0 CHECK (ads_tiktok >= 0),
  tarjeta_pago    NUMERIC NOT NULL DEFAULT 0 CHECK (tarjeta_pago >= 0),
  tarjeta_interes NUMERIC NOT NULL DEFAULT 0 CHECK (tarjeta_interes >= 0),
  notas           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monthly_business_inputs_year_month_idx
  ON public.monthly_business_inputs (year_month DESC);

-- ─────────────────────────────────────────────────────────────────
-- RLS — admin-only (datos financieros sensibles, mismo gate que wallet)
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.monthly_business_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "monthly_inputs_admin_select" ON public.monthly_business_inputs;
CREATE POLICY "monthly_inputs_admin_select"
  ON public.monthly_business_inputs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "monthly_inputs_admin_insert" ON public.monthly_business_inputs;
CREATE POLICY "monthly_inputs_admin_insert"
  ON public.monthly_business_inputs
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "monthly_inputs_admin_update" ON public.monthly_business_inputs;
CREATE POLICY "monthly_inputs_admin_update"
  ON public.monthly_business_inputs
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "monthly_inputs_admin_delete" ON public.monthly_business_inputs;
CREATE POLICY "monthly_inputs_admin_delete"
  ON public.monthly_business_inputs
  FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ─────────────────────────────────────────────────────────────────
-- Trigger updated_at — patrón estándar.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_monthly_business_inputs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS monthly_business_inputs_updated_at_trg
  ON public.monthly_business_inputs;
CREATE TRIGGER monthly_business_inputs_updated_at_trg
  BEFORE UPDATE ON public.monthly_business_inputs
  FOR EACH ROW EXECUTE FUNCTION public.tg_monthly_business_inputs_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- Setting: costos_fijos_mensuales (nómina + socio + apps).
-- Default = 3,080,000 COP. Editable desde /admin → Configuración via
-- el flujo existente de app_settings.
-- ─────────────────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value)
VALUES ('costos_fijos_mensuales', '3080000')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────
-- RPC helpers — upsert por year_month + lectura del setting.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_monthly_business_inputs(
  p_year_month     TEXT,
  p_ads_meta       NUMERIC,
  p_ads_tiktok     NUMERIC,
  p_tarjeta_pago   NUMERIC,
  p_tarjeta_interes NUMERIC,
  p_notas          TEXT
)
RETURNS public.monthly_business_inputs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.monthly_business_inputs;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  IF p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'year_month inválido (esperado YYYY-MM, recibido %)', p_year_month
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.monthly_business_inputs (
    year_month, ads_meta, ads_tiktok, tarjeta_pago, tarjeta_interes, notas
  ) VALUES (
    p_year_month,
    COALESCE(p_ads_meta, 0),
    COALESCE(p_ads_tiktok, 0),
    COALESCE(p_tarjeta_pago, 0),
    COALESCE(p_tarjeta_interes, 0),
    NULLIF(p_notas, '')
  )
  ON CONFLICT (year_month) DO UPDATE SET
    ads_meta        = EXCLUDED.ads_meta,
    ads_tiktok      = EXCLUDED.ads_tiktok,
    tarjeta_pago    = EXCLUDED.tarjeta_pago,
    tarjeta_interes = EXCLUDED.tarjeta_interes,
    notas           = EXCLUDED.notas
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_monthly_business_inputs(TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT)
  TO authenticated;
