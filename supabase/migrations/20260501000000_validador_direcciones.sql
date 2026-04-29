-- Schema para validador de direcciones con autocomplete.
-- Spec: docs/superpowers/specs/2026-04-29-validador-direcciones-design.md
--
-- Agrega columnas a orders (todas nullable, backwards-compat con Excel uploads),
-- tabla address_autocomplete_cache (L2), keys de app_settings para cuota Google,
-- y RPCs consume_google_quota + cleanup_expired_autocomplete_cache.

-- 1. Columnas nuevas en orders
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS barrio TEXT,
  ADD COLUMN IF NOT EXISTS complemento TEXT,
  ADD COLUMN IF NOT EXISTS documento_destinatario TEXT,
  ADD COLUMN IF NOT EXISTS google_place_id TEXT,
  ADD COLUMN IF NOT EXISTS lat NUMERIC,
  ADD COLUMN IF NOT EXISTS lng NUMERIC,
  ADD COLUMN IF NOT EXISTS validation_decision TEXT,
  ADD COLUMN IF NOT EXISTS address_kind TEXT,
  ADD COLUMN IF NOT EXISTS missing_fields JSONB,
  ADD COLUMN IF NOT EXISTS suggested_customer_message TEXT,
  ADD COLUMN IF NOT EXISTS address_parsed JSONB;

CREATE INDEX IF NOT EXISTS orders_google_place_id_idx
  ON public.orders(google_place_id)
  WHERE google_place_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_validation_decision_idx
  ON public.orders(validation_decision);

CREATE INDEX IF NOT EXISTS orders_phone_place_id_idx
  ON public.orders(phone)
  WHERE google_place_id IS NOT NULL;

-- 2. Tabla nueva address_autocomplete_cache (Cache L2)
CREATE TABLE IF NOT EXISTS public.address_autocomplete_cache (
  id BIGSERIAL PRIMARY KEY,
  query_normalized TEXT NOT NULL,
  ciudad_filter TEXT,
  suggestions JSONB NOT NULL,
  hit_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (query_normalized, ciudad_filter)
);

CREATE INDEX IF NOT EXISTS address_autocomplete_cache_expires_idx
  ON public.address_autocomplete_cache(expires_at);

ALTER TABLE public.address_autocomplete_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "autocomplete_cache_authenticated_all" ON public.address_autocomplete_cache;
CREATE POLICY "autocomplete_cache_authenticated_all"
  ON public.address_autocomplete_cache
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 3. Keys de app_settings para cuota Google diaria
INSERT INTO public.app_settings (key, value)
VALUES
  ('google_api_daily_budget_usd', '2.50'),
  ('google_api_used_today_usd',   '0.00'),
  ('google_api_used_today_date',  to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'))
ON CONFLICT (key) DO NOTHING;

-- 4. RPC consume_google_quota
CREATE OR REPLACE FUNCTION public.consume_google_quota(p_amount_usd NUMERIC)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_today TEXT := to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD');
  v_stored_date TEXT;
  v_used NUMERIC;
  v_budget NUMERIC;
BEGIN
  SELECT value INTO v_stored_date FROM app_settings WHERE key = 'google_api_used_today_date';
  IF v_stored_date IS DISTINCT FROM v_today THEN
    UPDATE app_settings SET value = '0.00' WHERE key = 'google_api_used_today_usd';
    UPDATE app_settings SET value = v_today  WHERE key = 'google_api_used_today_date';
  END IF;

  -- FOR UPDATE locks the row so concurrent quota consumers serialize and avoid
  -- lost updates that would let total spend exceed the cap.
  SELECT value::NUMERIC INTO v_used   FROM app_settings WHERE key = 'google_api_used_today_usd' FOR UPDATE;
  SELECT value::NUMERIC INTO v_budget FROM app_settings WHERE key = 'google_api_daily_budget_usd';

  IF v_used + p_amount_usd > v_budget THEN
    RETURN FALSE;
  END IF;

  UPDATE app_settings
  SET value = (v_used + p_amount_usd)::TEXT
  WHERE key = 'google_api_used_today_usd';

  RETURN TRUE;
END;
$func$;

REVOKE ALL ON FUNCTION public.consume_google_quota(NUMERIC) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.consume_google_quota(NUMERIC) TO authenticated, service_role;

-- 5. RPC cleanup_expired_autocomplete_cache
CREATE OR REPLACE FUNCTION public.cleanup_expired_autocomplete_cache()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM address_autocomplete_cache WHERE expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

REVOKE ALL ON FUNCTION public.cleanup_expired_autocomplete_cache() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_autocomplete_cache() TO service_role;

COMMENT ON TABLE public.address_autocomplete_cache IS
  'Cache L2 de sugerencias Google Places por query normalizada. TTL 30 días.';
COMMENT ON FUNCTION public.consume_google_quota(NUMERIC) IS
  'Atomic check-and-increment de cuota diaria Google APIs. Retorna FALSE si excede el cap.';
