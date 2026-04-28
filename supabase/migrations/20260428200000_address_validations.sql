-- Cache de validaciones de dirección
--
-- Cada dirección se valida una sola vez por TTL (24h). El cache_key es
-- la normalización de (direccion, ciudad, departamento) para que
-- variaciones triviales ("CL 5 #6-7" vs "calle 5 # 6-7") matcheen al
-- mismo registro y no quememos calls a Nominatim.
--
-- RLS: lectura para authenticated; escritura solo via service_role
-- desde la edge function (bypass RLS).
--
-- TTL: la edge function decide al momento de la lectura si el cache
-- está vencido (validated_at + 24h < now()). No hay job de limpieza
-- por ahora; si la tabla crece mucho, agregar un cron mensual con
-- DELETE de filas validated_at < now() - 30 days.

CREATE TABLE IF NOT EXISTS public.address_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key       TEXT       NOT NULL UNIQUE,
  direccion       TEXT       NOT NULL,
  ciudad          TEXT,
  departamento    TEXT,
  status          TEXT       NOT NULL CHECK (status IN ('valid', 'suspicious', 'invalid')),
  score           INTEGER    NOT NULL CHECK (score BETWEEN 0 AND 100),
  issues          TEXT[]     NOT NULL DEFAULT ARRAY[]::TEXT[],
  geocoded_lat    NUMERIC,
  geocoded_lng    NUMERIC,
  geocoded_display TEXT,
  validated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_address_validations_validated_at
  ON public.address_validations (validated_at DESC);

ALTER TABLE public.address_validations ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier authenticated (operadora consultando).
DROP POLICY IF EXISTS address_validations_read_authenticated ON public.address_validations;
CREATE POLICY address_validations_read_authenticated
  ON public.address_validations
  FOR SELECT
  TO authenticated
  USING (TRUE);

-- Sin INSERT/UPDATE policy → bloqueado por RLS para usuarios normales.
-- service_role (edge function) bypass RLS automáticamente.
