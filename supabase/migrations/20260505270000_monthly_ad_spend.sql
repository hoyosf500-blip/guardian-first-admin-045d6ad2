-- /cfo "Cómo voy" — tracker mensual de pauta (Meta + TikTok).
-- Una fila por (mes, plataforma, cuenta). Incluye método de pago para
-- saber qué porción de la pauta cae a TC USD diferida vs Amex/wallet.
-- Admin-only via RLS.

CREATE TABLE IF NOT EXISTS public.monthly_ad_spend (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year_month      TEXT NOT NULL CHECK (year_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  platform        TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok', 'other')),
  account_name    TEXT NOT NULL,
  amount_cop      NUMERIC NOT NULL DEFAULT 0 CHECK (amount_cop >= 0),
  payment_method  TEXT NOT NULL DEFAULT 'mastercard_usd'
                  CHECK (payment_method IN ('mastercard_usd', 'mastercard_cop', 'amex_cop', 'wallet', 'other')),
  notas           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year_month, platform, account_name)
);

CREATE INDEX IF NOT EXISTS monthly_ad_spend_ym_idx
  ON public.monthly_ad_spend (year_month DESC);

-- ─────────────────────────────────────────────────────────────────
-- RLS — admin-only.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.monthly_ad_spend ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ad_spend_admin_select" ON public.monthly_ad_spend;
CREATE POLICY "ad_spend_admin_select"
  ON public.monthly_ad_spend
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "ad_spend_admin_insert" ON public.monthly_ad_spend;
CREATE POLICY "ad_spend_admin_insert"
  ON public.monthly_ad_spend
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "ad_spend_admin_update" ON public.monthly_ad_spend;
CREATE POLICY "ad_spend_admin_update"
  ON public.monthly_ad_spend
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "ad_spend_admin_delete" ON public.monthly_ad_spend;
CREATE POLICY "ad_spend_admin_delete"
  ON public.monthly_ad_spend
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ─────────────────────────────────────────────────────────────────
-- Trigger updated_at.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_monthly_ad_spend_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS monthly_ad_spend_updated_at_trg
  ON public.monthly_ad_spend;
CREATE TRIGGER monthly_ad_spend_updated_at_trg
  BEFORE UPDATE ON public.monthly_ad_spend
  FOR EACH ROW EXECUTE FUNCTION public.tg_monthly_ad_spend_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- RPC upsert idempotente por (year_month, platform, account_name).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_monthly_ad_spend(
  p_year_month     TEXT,
  p_platform       TEXT,
  p_account_name   TEXT,
  p_amount_cop     NUMERIC,
  p_payment_method TEXT,
  p_notas          TEXT
)
RETURNS public.monthly_ad_spend
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.monthly_ad_spend;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  IF p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'year_month inválido (esperado YYYY-MM)' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.monthly_ad_spend (
    year_month, platform, account_name, amount_cop, payment_method, notas
  ) VALUES (
    p_year_month,
    p_platform,
    TRIM(p_account_name),
    COALESCE(p_amount_cop, 0),
    COALESCE(NULLIF(p_payment_method, ''), 'mastercard_usd'),
    NULLIF(p_notas, '')
  )
  ON CONFLICT (year_month, platform, account_name) DO UPDATE SET
    amount_cop     = EXCLUDED.amount_cop,
    payment_method = EXCLUDED.payment_method,
    notas          = EXCLUDED.notas
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_monthly_ad_spend(TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT)
  TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC delete (admin-only).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_monthly_ad_spend(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.monthly_ad_spend WHERE id = p_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_monthly_ad_spend(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- Seeds históricos (datos ene-abr 2026 que Fabian compartió 5-may-2026
-- vía screenshots Meta Ads Manager + TikTok Centro de Negocios).
-- ─────────────────────────────────────────────────────────────────

INSERT INTO public.monthly_ad_spend
  (year_month, platform, account_name, amount_cop, payment_method, notas)
VALUES
  ('2026-01', 'meta', 'Andres Pitalito', 701190, 'mastercard_usd',
   'Único set activo en enero (mes de arranque del negocio).'),
  ('2026-02', 'meta', 'CPP CLON 7', 12704406, 'mastercard_usd', 'Cuenta dominante de febrero — sin retorno todavía.'),
  ('2026-02', 'meta', 'Andres Pitalito', 1848692, 'mastercard_usd', NULL),
  ('2026-02', 'meta', 'CPP CLON 12', 1286311, 'mastercard_usd', NULL),
  ('2026-02', 'meta', 'killer 6', 690156, 'mastercard_usd', NULL),
  ('2026-02', 'meta', 'killer 1', 387232, 'mastercard_usd', NULL),
  ('2026-03', 'meta', 'CPP CLON 7', 9772787, 'mastercard_usd', 'Sigue siendo la cuenta dominante.'),
  ('2026-03', 'meta', 'CPP CLON 12', 3918158, 'mastercard_usd', 'Empezó a despegar acá.'),
  ('2026-03', 'meta', 'Andres Pitalito', 182545, 'mastercard_usd', 'Bajaste fuerte vs feb — bien hecho.'),
  ('2026-04', 'meta', 'CPP CLON 7', 5672932, 'mastercard_usd', 'ROAS 4.68x.'),
  ('2026-04', 'meta', 'CPP CLON 12', 4614817, 'mastercard_usd', 'ROAS 6.60x — top performer Meta.'),
  ('2026-04', 'meta', 'Andres Pitalito', 948246, 'mastercard_usd', 'ROAS 3.10x — al límite, candidato a pausar.'),
  ('2026-04', 'tiktok', 'INSTITUTO SAN JUDAS TADEO', 3118768.55, 'amex_cop',
   'CPA $14.922 — mejor cuenta TikTok. 209 conversiones.'),
  ('2026-04', 'tiktok', 'san judas3', 2032745.50, 'amex_cop', 'CPA $23.364 — peor que el principal.'),
  ('2026-04', 'tiktok', 'san judas 1', 1879652.52, 'amex_cop', 'CPA $21.359.'),
  ('2026-04', 'tiktok', 'san judas2', 1734456.05, 'amex_cop', 'CPA $21.680.')
ON CONFLICT (year_month, platform, account_name) DO UPDATE SET
  amount_cop     = EXCLUDED.amount_cop,
  payment_method = EXCLUDED.payment_method,
  notas          = EXCLUDED.notas;
