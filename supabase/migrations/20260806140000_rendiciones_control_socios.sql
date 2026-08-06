-- ============================================================================
-- Rendiciones — el control de la plata que sale de la billetera.
--
-- POR QUÉ EXISTE
-- La billetera de Dropi ya registra sola cada `retiro`, y `store_ad_spend_daily`
-- registra la pauta. Lo que NO existía en Guardian era el papel del medio: quién
-- sacó esa plata y en qué la gastó, comprobante por comprobante. Sin eso los dos
-- lados nunca se cruzan y la diferencia —la plata sin explicar— no la ve nadie.
--
-- El caso que lo motivó (agosto 2026, tienda Ecuador): la rendición del 23-jul
-- volvió a cobrar un cargo de "UGLY 06/07" por $500 que ya se había pagado en la
-- del 19-jul. Se pagaron $1.278,14 cuando los débitos verificados sumaban $759,14.
-- Los $519 de diferencia ($500 + su 3,8% de comisión) aparecieron recién al poner
-- las dos rendiciones lado a lado en un Excel armado a mano. Esta tabla es para
-- que eso lo encuentre el sistema, no una tarde de trabajo manual.
--
-- DOS TABLAS, NO UNA. La cabecera es el RETIRO (una salida de plata) y los ítems
-- son los comprobantes que lo justifican. El detector de duplicados necesita los
-- ítems sueltos: compara concepto+monto ENTRE rendiciones distintas, que es
-- exactamente el patrón del $500.
--
-- NO se reusa `store_ad_spend_daily` para los ítems: esa tabla es un agregado por
-- (día, plataforma) con UNIQUE, y acá se necesitan comprobantes individuales con
-- su concepto. Distinto grano, distinto propósito. La pauta sigue siendo la fuente
-- del Neto Real; las rendiciones son el control de caja.
--
-- PERMISOS: OWNER de la tienda, no manager. Decisión del dueño (2026-08-06): la
-- asesora sigue mandando comprobantes por WhatsApp y él los carga. Un supervisor
-- NO debe poder editar la rendición que lo audita a él.
--
-- Montos en la MONEDA DE LA TIENDA (USD en EC, COP en CO), igual que
-- store_ad_spend_daily — por eso la columna se llama `monto` y no `monto_cop`.
-- ============================================================================

-- ── Cabecera: un retiro de la billetera ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_rendiciones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  fecha           DATE NOT NULL,
  -- Texto libre a propósito: quien rinde puede no tener usuario en Guardian
  -- (hoy la asesora manda por WhatsApp y el dueño carga). Forzar un FK a
  -- auth.users obligaría a darle acceso a alguien solo para poder nombrarlo.
  responsable     TEXT,
  -- Lo que SALIÓ de la billetera. Se compara contra los movimientos reales de
  -- `dropi_wallet_movements` con categoria='retiro' — si no cuadra, se avisa.
  monto_retirado  NUMERIC NOT NULL DEFAULT 0 CHECK (monto_retirado >= 0),
  notas           TEXT,
  created_by      UUID DEFAULT auth.uid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_rendiciones_store_fecha_idx
  ON public.store_rendiciones (store_id, fecha DESC);

-- ── Ítems: los comprobantes que justifican ese retiro ──────────────────────
CREATE TABLE IF NOT EXISTS public.store_rendicion_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rendicion_id  UUID NOT NULL REFERENCES public.store_rendiciones(id) ON DELETE CASCADE,
  fecha         DATE,
  -- El texto del comprobante tal como viene ("UGLY 06/07"). Es la mitad de la
  -- llave con la que se detectan los cobros repetidos.
  concepto      TEXT NOT NULL,
  monto         NUMERIC NOT NULL DEFAULT 0 CHECK (monto >= 0),
  -- Sirve para cruzar contra store_ad_spend_daily por plataforma.
  plataforma    TEXT CHECK (plataforma IN ('meta','tiktok','otro')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_rendicion_items_rendicion_idx
  ON public.store_rendicion_items (rendicion_id);

-- ── RLS — OWNER de la tienda, en las dos tablas ────────────────────────────
ALTER TABLE public.store_rendiciones      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_rendicion_items  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rendiciones_owner_all" ON public.store_rendiciones;
CREATE POLICY "rendiciones_owner_all" ON public.store_rendiciones
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

-- Los ítems heredan el permiso de su cabecera. Sin este EXISTS, un ítem con un
-- rendicion_id ajeno sería insertable: la tabla hija no conoce el store_id.
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

-- ── RPC de escritura: cabecera + ítems en UNA transacción ──────────────────
-- Guardar la cabecera y los ítems en dos viajes deja, si el segundo falla, un
-- retiro sin comprobantes que el cruce lee como "$X sin explicar" — una alerta
-- falsa sobre plata que sí se rindió. Va todo junto o no va nada.
CREATE OR REPLACE FUNCTION public.upsert_rendicion(
  p_store_id       UUID,
  p_fecha          DATE,
  p_responsable    TEXT,
  p_monto_retirado NUMERIC,
  p_notas          TEXT,
  p_items          JSONB,          -- [{fecha, concepto, monto, plataforma}, ...]
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
    -- Sin esto, un id de otra tienda devolvía NULL en silencio y el cliente
    -- creía haber guardado.
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
  DELETE FROM public.store_rendiciones WHERE id = p_id;  -- los ítems caen por CASCADE
  RETURN TRUE;
END;
$$;

-- ── RPC de lectura: rendiciones del rango, con sus ítems anidados ──────────
-- Devuelve el JSON armado para que el cliente no tenga que hacer dos queries y
-- unirlas a mano (donde una falla parcial se vería como "rendición sin ítems" =
-- plata sin explicar que sí estaba explicada).
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

-- ── RPC del balance mes a mes ──────────────────────────────────────────────
-- Reproduce la hoja RESUMEN del Excel: una fila por mes con operativo, pauta,
-- admin, utilidad y ROI. Todo sale de fuentes que Guardian YA tiene; lo único
-- que hace esta función es juntarlas por mes en un solo viaje, en vez de que el
-- cliente dispare 3 queries por cada mes del rango.
--
-- `operativo` sale del wallet por COHORTE de pedido (la misma atribución que usa
-- "Cómo voy" y que reconcilia con la "Utilidad Total" de Dropi), NO por fecha de
-- pago — mezclar las dos bases fue justo lo que hizo desconfiar de las cifras.
CREATE OR REPLACE FUNCTION public.balance_mensual(
  p_store_id UUID,
  p_desde    TEXT,   -- 'YYYY-MM' inclusive
  p_hasta    TEXT    -- 'YYYY-MM' inclusive
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
  -- Pauta DIARIA (bitácora). Es la fuente principal desde 2026-07.
  ads AS (
    SELECT to_char(spend_date, 'YYYY-MM') AS ym, SUM(amount) AS pauta
    FROM public.store_ad_spend_daily
    WHERE store_id = p_store_id
    GROUP BY 1
  ),
  -- Costos mensuales: admin + la pauta MENSUAL guardada, que es el fallback para
  -- los meses viejos que solo tienen el número del mes y no el detalle diario.
  costos AS (
    SELECT year_month AS ym,
           SUM(costos_admin) AS admin,
           SUM(COALESCE(pauta_meta, 0) + COALESCE(pauta_tiktok, 0)) AS pauta_mensual
    FROM public.logistica_monthly_costs
    WHERE store_id = p_store_id
    GROUP BY 1
  ),
  -- Lo que SALIÓ de la billetera (retiros reales, los trae el sync solo).
  retiros AS (
    SELECT to_char(fecha, 'YYYY-MM') AS ym, SUM(monto) AS retirado
    FROM public.dropi_wallet_movements
    WHERE store_id = p_store_id AND categoria = 'retiro'
    GROUP BY 1
  ),
  -- Lo que se RINDIÓ con comprobante.
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
         -- El operativo NO se recalcula acá: se PIDE al mismo RPC que alimenta
         -- "Cómo voy". Reimplementar la fórmula habría dado dos cifras distintas
         -- para el mismo mes según la pantalla — exactamente el problema que
         -- este módulo viene a cerrar.
         COALESCE(oc.operativo, 0),
         -- Pauta: manda la bitácora diaria; si el mes no tiene registros diarios
         -- (meses viejos, cargados como un solo número), cae al valor mensual
         -- guardado. Es la MISMA regla que MesActualResumen, así que las dos
         -- pantallas no pueden discrepar.
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
