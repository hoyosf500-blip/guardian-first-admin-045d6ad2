-- Costos mensuales de LOGÍSTICA (pauta Meta/TikTok + costos admin) para el
-- "Neto Real" de la pantalla "Cómo voy" (/logistica → Resumen).
--
-- EXCLUSIVA de logística — NO toca el módulo CFO. monthly_ad_spend /
-- monthly_business_inputs siguen siendo admin-only y aparte; esta tabla es
-- STORE-SCOPED: el dueño/manager de la tienda carga SUS costos sin necesitar
-- admin global (la pantalla "Cómo voy" la ven los socios, managerOnly).
--
-- Pauta separada Meta/TikTok desde ya, aunque hoy solo se use Meta — así no se
-- rehace el esquema al sumar TikTok. La UI suma ambas.
--
-- NO se auto-aplica (Lovable): correr `supabase db push` o prompt de Lovable.
-- El cliente DEGRADA ELEGANTE si la tabla aún no existe (el hook devuelve ceros,
-- la pantalla no se rompe).

CREATE TABLE IF NOT EXISTS public.logistica_monthly_costs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  year_month   text NOT NULL CHECK (year_month ~ '^\d{4}-\d{2}$'),
  pauta_meta   numeric NOT NULL DEFAULT 0,
  pauta_tiktok numeric NOT NULL DEFAULT 0,
  costos_admin numeric NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, year_month)
);

ALTER TABLE public.logistica_monthly_costs ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier miembro de la tienda ve los costos de SU tienda.
DROP POLICY IF EXISTS "members read store logistica costs" ON public.logistica_monthly_costs;
CREATE POLICY "members read store logistica costs"
  ON public.logistica_monthly_costs
  FOR SELECT
  TO authenticated
  USING (public.is_store_member(store_id));

-- Escritura: SOLO vía el RPC upsert (SECURITY DEFINER). Sin policy de INSERT/
-- UPDATE/DELETE directo → nadie escribe la tabla a mano; todo pasa por el RPC
-- que valida membresía. Mismo patrón que dropi_wallet_movements.

CREATE OR REPLACE FUNCTION public.upsert_logistica_monthly_costs(
  p_store_id     uuid,
  p_year_month   text,
  p_pauta_meta   numeric,
  p_pauta_tiktok numeric,
  p_costos_admin numeric
)
RETURNS public.logistica_monthly_costs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_row public.logistica_monthly_costs;
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No sos miembro de esta tienda' USING ERRCODE = '42501';
  END IF;
  IF p_year_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'year_month inválido (esperado YYYY-MM): %', p_year_month USING ERRCODE = '22007';
  END IF;

  INSERT INTO public.logistica_monthly_costs
    (store_id, year_month, pauta_meta, pauta_tiktok, costos_admin, updated_at)
  VALUES
    (p_store_id, p_year_month,
     COALESCE(p_pauta_meta, 0), COALESCE(p_pauta_tiktok, 0), COALESCE(p_costos_admin, 0), now())
  ON CONFLICT (store_id, year_month) DO UPDATE SET
    pauta_meta   = EXCLUDED.pauta_meta,
    pauta_tiktok = EXCLUDED.pauta_tiktok,
    costos_admin = EXCLUDED.costos_admin,
    updated_at   = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.upsert_logistica_monthly_costs(uuid, text, numeric, numeric, numeric) TO authenticated;
