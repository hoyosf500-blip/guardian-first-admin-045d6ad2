-- ── Cabecera: un retiro de la billetera ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_rendiciones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  fecha           DATE NOT NULL,
  responsable     TEXT,
  monto_retirado  NUMERIC NOT NULL DEFAULT 0 CHECK (monto_retirado >= 0),
  notas           TEXT,
  created_by      UUID DEFAULT auth.uid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_rendiciones_store_fecha_idx
  ON public.store_rendiciones (store_id, fecha DESC);

CREATE TABLE IF NOT EXISTS public.store_rendicion_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rendicion_id  UUID NOT NULL REFERENCES public.store_rendiciones(id) ON DELETE CASCADE,
  fecha         DATE,
  concepto      TEXT NOT NULL,
  monto         NUMERIC NOT NULL DEFAULT 0 CHECK (monto >= 0),
  plataforma    TEXT CHECK (plataforma IN ('meta','tiktok','otro')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_rendicion_items_rendicion_idx
  ON public.store_rendicion_items (rendicion_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_rendiciones TO authenticated;
GRANT ALL ON public.store_rendiciones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_rendicion_items TO authenticated;
GRANT ALL ON public.store_rendicion_items TO service_role;

ALTER TABLE public.store_rendiciones      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_rendicion_items  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rendiciones_owner_all" ON public.store_rendiciones;
CREATE POLICY "rendiciones_owner_all" ON public.store_rendiciones
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

DROP POLICY IF EXISTS "rendicion_items_owner_all" ON public.store_rendicion_items;
CREATE POLICY "rendicion_items_owner_all" ON public.store_rendicion_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.store_rendiciones r
    WHERE r.id = rendicion_id AND public.is_store_owner(r.store_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.store_rendiciones r
    WHERE r.id = rendicion_id AND public.is_store_owner(r.store_id)
  ));

CREATE OR REPLACE FUNCTION public.upsert_rendicion(
  p_store_id       UUID,
  p_fecha          DATE,
  p_responsable    TEXT,
  p_monto_retirado NUMERIC,
  p_notas          TEXT,
  p_items          JSONB,
  p_id             UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede cargar rendiciones'
      USING ERRCODE = '42501';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.store_rendiciones (store_id, fecha, responsable, monto_retirado, notas)
    VALUES (p_store_id, p_fecha, NULLIF(btrim(p_responsable), ''), COALESCE(p_monto_retirado, 0), NULLIF(btrim(p_notas), ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.store_rendiciones
    SET fecha = p_fecha,
        responsable = NULLIF(btrim(p_responsable), ''),
        monto_retirado = COALESCE(p_monto_retirado, 0),
        notas = NULLIF(btrim(p_notas), ''),
        updated_at = now()
    WHERE id = p_id AND store_id = p_store_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Rendición no encontrada en esta tienda' USING ERRCODE = 'P0002';
    END IF;
    DELETE FROM public.store_rendicion_items WHERE rendicion_id = v_id;
  END IF;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    INSERT INTO public.store_rendicion_items (rendicion_id, fecha, concepto, monto, plataforma)
    SELECT v_id,
           NULLIF(it->>'fecha', '')::date,
           btrim(it->>'concepto'),
           COALESCE(NULLIF(it->>'monto', '')::numeric, 0),
           NULLIF(it->>'plataforma', '')
    FROM jsonb_array_elements(p_items) AS it
    WHERE btrim(COALESCE(it->>'concepto', '')) <> '';
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_rendicion(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_store UUID;
BEGIN
  SELECT store_id INTO v_store FROM public.store_rendiciones WHERE id = p_id;
  IF v_store IS NULL THEN RETURN FALSE; END IF;
  IF NOT public.is_store_owner(v_store) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede borrar rendiciones'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.store_rendiciones WHERE id = p_id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.rendiciones_range(
  p_store_id UUID,
  p_from     DATE,
  p_to       DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede ver las rendiciones'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.fecha DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT r.id, r.fecha, r.responsable, r.monto_retirado, r.notas,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', i.id, 'fecha', i.fecha, 'concepto', i.concepto,
                      'monto', i.monto, 'plataforma', i.plataforma
                    ) ORDER BY i.fecha NULLS LAST, i.concepto)
             FROM public.store_rendicion_items i WHERE i.rendicion_id = r.id
           ), '[]'::jsonb) AS items
    FROM public.store_rendiciones r
    WHERE r.store_id = p_store_id
      AND r.fecha BETWEEN p_from AND p_to
  ) t;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_mensual(
  p_store_id UUID,
  p_desde    TEXT,
  p_hasta    TEXT
)
RETURNS TABLE(
  year_month     TEXT,
  operativo      NUMERIC,
  pauta          NUMERIC,
  admin          NUMERIC,
  retirado       NUMERIC,
  rendido        NUMERIC,
  pedidos        BIGINT,
  entregados     BIGINT,
  devueltos      BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta tienda' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH meses AS (
    SELECT to_char(d, 'YYYY-MM') AS ym,
           d::date               AS mes_ini,
           (d + INTERVAL '1 month - 1 day')::date AS mes_fin
    FROM generate_series(
      to_date(p_desde || '-01', 'YYYY-MM-DD'),
      to_date(p_hasta || '-01', 'YYYY-MM-DD'),
      INTERVAL '1 month'
    ) AS d
  ),
  ads AS (
    SELECT to_char(spend_date, 'YYYY-MM') AS ym, SUM(amount) AS pauta
    FROM public.store_ad_spend_daily
    WHERE store_id = p_store_id
    GROUP BY 1
  ),
  costos AS (
    SELECT year_month AS ym,
           SUM(costos_admin) AS admin,
           SUM(COALESCE(pauta_meta, 0) + COALESCE(pauta_tiktok, 0)) AS pauta_mensual
    FROM public.logistica_monthly_costs
    WHERE store_id = p_store_id
    GROUP BY 1
  ),
  retiros AS (
    SELECT to_char(fecha, 'YYYY-MM') AS ym, SUM(monto) AS retirado
    FROM public.dropi_wallet_movements
    WHERE store_id = p_store_id AND categoria = 'retiro'
    GROUP BY 1
  ),
  rend AS (
    SELECT to_char(r.fecha, 'YYYY-MM') AS ym, SUM(i.monto) AS rendido
    FROM public.store_rendiciones r
    JOIN public.store_rendicion_items i ON i.rendicion_id = r.id
    WHERE r.store_id = p_store_id
    GROUP BY 1
  ),
  pedidos_mes AS (
    SELECT to_char(o.fecha::date, 'YYYY-MM') AS ym,
           COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) <> 'cancelado') AS pedidos,
           COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'entregado')  AS entregados,
           COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'devuelto')   AS devueltos
    FROM public.orders o
    WHERE o.store_id = p_store_id
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND public._estado_bucket(o.estado) <> 'borrado'
    GROUP BY 1
  )
  SELECT m.ym,
         COALESCE(oc.operativo, 0),
         CASE WHEN COALESCE(ads.pauta, 0) > 0
              THEN ads.pauta
              ELSE COALESCE(costos.pauta_mensual, 0) END,
         COALESCE(costos.admin, 0),
         COALESCE(retiros.retirado, 0),
         COALESCE(rend.rendido, 0),
         COALESCE(pedidos_mes.pedidos, 0),
         COALESCE(pedidos_mes.entregados, 0),
         COALESCE(pedidos_mes.devueltos, 0)
  FROM meses m
  LEFT JOIN LATERAL (
    SELECT * FROM public.operativo_mes_cohorte(p_store_id, m.ym)
  ) oc ON TRUE
  LEFT JOIN ads         ON ads.ym = m.ym
  LEFT JOIN costos      ON costos.ym = m.ym
  LEFT JOIN retiros     ON retiros.ym = m.ym
  LEFT JOIN rend        ON rend.ym = m.ym
  LEFT JOIN pedidos_mes ON pedidos_mes.ym = m.ym
  ORDER BY m.ym;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_rendicion(UUID, DATE, TEXT, NUMERIC, TEXT, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_rendicion(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rendiciones_range(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.balance_mensual(UUID, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';