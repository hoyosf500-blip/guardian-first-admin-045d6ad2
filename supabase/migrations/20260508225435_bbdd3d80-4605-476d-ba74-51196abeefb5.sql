-- Sanitización para clonar a clientes externos
-- Idempotente: usa ON CONFLICT y borrados condicionados.

-- 1) Settings de marca / tienda (vacíos por defecto, llenados por el wizard)
INSERT INTO public.app_settings (key, value) VALUES ('brand_name', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('brand_logo_url', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_store_url', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_session_token', '') ON CONFLICT (key) DO NOTHING;

-- 2) Vaciar el white_brand_id hardcodeado en migración 20260415104008.
--    Solo se vacía si tiene exactamente ese valor (no toca un valor llenado por el wizard).
UPDATE public.app_settings
SET value = ''
WHERE key = 'dropi_white_brand_id'
  AND value = 'df3e6b0bb66ceaadca4f84cbc371fd66e04d20fe51fc414da8d1b84d31d178de';

-- 3) Marcador "instancia del dueño original". Si NO existe, no es la instancia original.
INSERT INTO public.app_settings (key, value) VALUES ('is_seed_data_owner', 'false') ON CONFLICT (key) DO NOTHING;

-- 4) Limpieza condicional del seed Q1 (marzo/abril 2026) de la bitácora financiera.
--    Solo borra en instancias NUEVAS (is_seed_data_owner != 'true').
--    En la instancia del dueño original esa fila ya está en 'true' (insertada antes de esta migración).
DO $$
DECLARE
  v_is_owner text;
BEGIN
  SELECT value INTO v_is_owner FROM public.app_settings WHERE key = 'is_seed_data_owner';
  IF v_is_owner IS DISTINCT FROM 'true' THEN
    DELETE FROM public.cfo_monthly_retrospective
    WHERE year_month IN ('2026-03', '2026-04');
  END IF;
END $$;