-- Control diario de pauta por tienda (Meta/TikTok), aparte de la mensual del CFO.
CREATE TABLE IF NOT EXISTS public.store_ad_spend_daily (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  spend_date  DATE NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('meta','tiktok','other')),
  amount      NUMERIC NOT NULL DEFAULT 0 CHECK (amount >= 0),
  notas       TEXT,
  created_by  UUID DEFAULT auth.uid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, spend_date, platform)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_ad_spend_daily TO authenticated;
GRANT ALL ON public.store_ad_spend_daily TO service_role;

CREATE INDEX IF NOT EXISTS store_ad_spend_daily_store_date_idx
  ON public.store_ad_spend_daily (store_id, spend_date DESC);

ALTER TABLE public.store_ad_spend_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "store_ad_spend_manager_select" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_select" ON public.store_ad_spend_daily
  FOR SELECT TO authenticated USING (public.is_store_manager(store_id));

DROP POLICY IF EXISTS "store_ad_spend_manager_insert" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_insert" ON public.store_ad_spend_daily
  FOR INSERT TO authenticated WITH CHECK (public.is_store_manager(store_id));

DROP POLICY IF EXISTS "store_ad_spend_manager_update" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_update" ON public.store_ad_spend_daily
  FOR UPDATE TO authenticated
  USING (public.is_store_manager(store_id))
  WITH CHECK (public.is_store_manager(store_id));

DROP POLICY IF EXISTS "store_ad_spend_manager_delete" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_delete" ON public.store_ad_spend_daily
  FOR DELETE TO authenticated USING (public.is_store_manager(store_id));

CREATE OR REPLACE FUNCTION public.tg_store_ad_spend_daily_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS store_ad_spend_daily_updated_at_trg ON public.store_ad_spend_daily;
CREATE TRIGGER store_ad_spend_daily_updated_at_trg
  BEFORE UPDATE ON public.store_ad_spend_daily
  FOR EACH ROW EXECUTE FUNCTION public.tg_store_ad_spend_daily_updated_at();

CREATE OR REPLACE FUNCTION public.upsert_store_ad_spend_daily(
  p_store_id   UUID,
  p_spend_date DATE,
  p_platform   TEXT,
  p_amount     NUMERIC,
  p_notas      TEXT
)
RETURNS public.store_ad_spend_daily
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_row public.store_ad_spend_daily;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Solo encargados de la tienda' USING ERRCODE = '42501';
  END IF;
  IF p_platform NOT IN ('meta','tiktok','other') THEN
    RAISE EXCEPTION 'platform inválido' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.store_ad_spend_daily (store_id, spend_date, platform, amount, notas, created_by)
  VALUES (p_store_id, p_spend_date, p_platform, COALESCE(p_amount, 0), NULLIF(p_notas, ''), auth.uid())
  ON CONFLICT (store_id, spend_date, platform) DO UPDATE SET
    amount = EXCLUDED.amount,
    notas  = EXCLUDED.notas
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_store_ad_spend_daily(UUID, DATE, TEXT, NUMERIC, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_store_ad_spend_daily(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_store UUID;
BEGIN
  SELECT store_id INTO v_store FROM public.store_ad_spend_daily WHERE id = p_id;
  IF v_store IS NULL THEN RETURN FALSE; END IF;
  IF NOT public.is_store_manager(v_store) THEN
    RAISE EXCEPTION 'Solo encargados de la tienda' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.store_ad_spend_daily WHERE id = p_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_store_ad_spend_daily(UUID) TO authenticated;