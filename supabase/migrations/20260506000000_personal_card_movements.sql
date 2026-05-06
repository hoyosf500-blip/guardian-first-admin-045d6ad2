-- /cfo → "Análisis tarjetas (gasto personal)"
--
-- Persistencia + categorización de movimientos de TC personales del dueño.
-- Datos vienen vía edge function parse-bank-pdf-text (cliente extrae texto
-- del PDF Bancolombia con pdfjs-dist y manda batch). Idempotente por
-- (tarjeta, fecha, numero_autorizacion, monto, moneda, cuota_numero,
-- periodo_corte_to) para que reimportar el mismo PDF no duplique y para
-- que la misma compra reaparecida en otro corte (cuota 2/36) sí entre.
--
-- Es admin-only — solo el dueño ve sus tarjetas personales. No se mezcla
-- con dropi_wallet_movements (eso es operación del negocio).

-- ─────────────────────────────────────────────────────────────────
-- Tabla principal.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.personal_card_movements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tarjeta               TEXT NOT NULL,                                  -- "*9999", "*6109"
  marca                 TEXT NOT NULL CHECK (marca IN ('mastercard', 'amex', 'otro')),
  banco                 TEXT NOT NULL DEFAULT 'Bancolombia',
  fecha                 DATE NOT NULL,
  descripcion           TEXT NOT NULL,
  numero_autorizacion   TEXT,
  monto                 NUMERIC NOT NULL,                               -- positivo = cargo, negativo = abono
  moneda                TEXT NOT NULL CHECK (moneda IN ('COP', 'USD')),
  tipo                  TEXT NOT NULL CHECK (tipo IN ('compra', 'abono', 'intereses', 'comision', 'avance', 'otro')),
  cuotas_total          INT,
  cuota_numero          INT,
  valor_cuota           NUMERIC,
  interes_mensual_pct   NUMERIC,
  interes_anual_pct     NUMERIC,
  saldo_pendiente       NUMERIC,
  categoria             TEXT NOT NULL DEFAULT 'otro',
  subcategoria          TEXT,
  es_negocio            BOOLEAN NOT NULL DEFAULT false,
  periodo_corte_from    DATE,
  periodo_corte_to      DATE,
  origen_pdf            TEXT,
  notas                 TEXT,
  raw_line              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT personal_card_movements_unique
    UNIQUE (tarjeta, fecha, numero_autorizacion, monto, moneda, cuota_numero, periodo_corte_to)
);

CREATE INDEX IF NOT EXISTS personal_card_movements_fecha_idx
  ON public.personal_card_movements (fecha DESC);

CREATE INDEX IF NOT EXISTS personal_card_movements_categoria_idx
  ON public.personal_card_movements (categoria, fecha DESC);

CREATE INDEX IF NOT EXISTS personal_card_movements_tarjeta_idx
  ON public.personal_card_movements (tarjeta, fecha DESC);

CREATE INDEX IF NOT EXISTS personal_card_movements_negocio_idx
  ON public.personal_card_movements (es_negocio, fecha DESC);

-- ─────────────────────────────────────────────────────────────────
-- RLS — admin-only.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.personal_card_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "personal_card_admin_select" ON public.personal_card_movements;
CREATE POLICY "personal_card_admin_select"
  ON public.personal_card_movements
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "personal_card_admin_update" ON public.personal_card_movements;
CREATE POLICY "personal_card_admin_update"
  ON public.personal_card_movements
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "personal_card_admin_delete" ON public.personal_card_movements;
CREATE POLICY "personal_card_admin_delete"
  ON public.personal_card_movements
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- INSERT bloqueado a clientes — solo via RPC bulk upsert.

CREATE OR REPLACE FUNCTION public.tg_personal_card_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS personal_card_updated_at_trg ON public.personal_card_movements;
CREATE TRIGGER personal_card_updated_at_trg
  BEFORE UPDATE ON public.personal_card_movements
  FOR EACH ROW EXECUTE FUNCTION public.tg_personal_card_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- Categorización: función pura. Cliente y server comparten la misma
-- lógica vía esta RPC. El orden importa — primer match gana.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.categorize_personal_movement(
  p_descripcion TEXT,
  p_moneda      TEXT DEFAULT 'COP'
)
RETURNS TABLE (
  categoria     TEXT,
  subcategoria  TEXT,
  es_negocio    BOOLEAN
)
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_desc TEXT;
BEGIN
  v_desc := UPPER(COALESCE(p_descripcion, ''));

  -- ═══ NEGOCIO ═══
  IF v_desc LIKE 'FACEBK%' OR v_desc LIKE 'FACEBOOK%' OR v_desc LIKE '%META PLATFORMS%' THEN
    RETURN QUERY SELECT 'pauta_facebook'::TEXT, 'Meta Ads'::TEXT, TRUE;
    RETURN;
  END IF;

  IF v_desc LIKE 'TIKTOK%' OR v_desc LIKE '%BYTEDANCE%' THEN
    RETURN QUERY SELECT 'pauta_tiktok'::TEXT, 'TikTok Ads'::TEXT, TRUE;
    RETURN;
  END IF;

  IF v_desc LIKE 'HOTMART%' THEN
    RETURN QUERY SELECT 'educacion'::TEXT, 'Hotmart'::TEXT, TRUE;
    RETURN;
  END IF;

  IF v_desc LIKE 'HIGGSFIELD%' THEN
    RETURN QUERY SELECT 'software_negocio'::TEXT, 'Higgsfield AI'::TEXT, TRUE;
    RETURN;
  END IF;

  -- ═══ FINANCIERO TC ═══
  IF v_desc LIKE 'COMISION AVANCE%' THEN
    RETURN QUERY SELECT 'comision_avance'::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'AVANCE%' OR v_desc LIKE '%ANTICIPO%' THEN
    RETURN QUERY SELECT 'avance_efectivo'::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'INTERESES%' THEN
    RETURN QUERY SELECT 'intereses'::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'ABONO%' OR v_desc LIKE '%PAGO TARJETA%' THEN
    RETURN QUERY SELECT 'abono_pago'::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  -- ═══ COMIDA ═══
  IF v_desc LIKE 'RAPPI%' OR v_desc LIKE '%RAPPI COLOMBIA%' THEN
    RETURN QUERY SELECT 'comida_delivery'::TEXT, 'Rappi'::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE '%SAZOMA%' OR v_desc LIKE 'PUB LA PINTA%' OR v_desc LIKE 'CREPES Y WAFFLES%'
     OR v_desc LIKE 'FRISBY%' OR v_desc LIKE 'MERA EL DORADO%' OR v_desc LIKE 'GOURMET CHARDY%'
     OR v_desc LIKE 'PARILLLA%' OR v_desc LIKE 'PARILLA%' OR v_desc LIKE '%KING PAPA%'
     OR v_desc LIKE 'EL ANTOJO%' OR v_desc LIKE 'TJV%' OR v_desc LIKE 'TODODEIA%' THEN
    RETURN QUERY SELECT 'comida_restaurante'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'EXITO%' OR v_desc LIKE '%SUPER LA GRAN%' OR v_desc LIKE 'DOLLARCITY%' THEN
    RETURN QUERY SELECT 'mercado'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'DROGUERIA%' OR v_desc LIKE '%FARMACIA%' THEN
    RETURN QUERY SELECT 'salud'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  -- ═══ PERSONAL DISCRECIONAL ═══
  IF v_desc LIKE 'YIRE SPORT%' OR v_desc LIKE 'HYM JARDIN%' OR v_desc LIKE '%H&M%'
     OR v_desc LIKE 'BOLD*THEZONASHOP%' OR v_desc LIKE 'BOLD*FRACOL%' OR v_desc LIKE 'BOLD*KREMA%'
     OR v_desc LIKE 'TMAX TECHNOLOGY%' THEN
    RETURN QUERY SELECT 'compras_personales'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'AVIANCA%' OR v_desc LIKE 'LATAM%' OR v_desc LIKE '%AIRBNB%'
     OR v_desc LIKE '%BOOKING%' OR v_desc LIKE '%HOTEL%' THEN
    RETURN QUERY SELECT 'viajes'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'NETFLIX%' OR v_desc LIKE '%SPOTIFY%' OR v_desc LIKE '%DISNEY%'
     OR v_desc LIKE '%PRIME VIDEO%' OR v_desc LIKE 'GREEN GYM%' OR v_desc LIKE '%SMART FIT%' THEN
    RETURN QUERY SELECT 'suscripciones'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE '%TEMU%' OR v_desc LIKE '%SHEIN%' OR v_desc LIKE '%MERCADOLIBRE%'
     OR v_desc LIKE '%AMAZON%' THEN
    RETURN QUERY SELECT 'compras_online'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'ESTACION DE SERVICIO%' OR v_desc LIKE '%TERPEL%' OR v_desc LIKE '%PRIMAX%' THEN
    RETURN QUERY SELECT 'transporte'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'BOLD*POWER%' OR v_desc LIKE 'BOLD*%' THEN
    RETURN QUERY SELECT 'compras_personales'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  IF v_desc LIKE 'CENTRO COMERCIAL%' OR v_desc LIKE 'ALMACEN%' THEN
    RETURN QUERY SELECT 'compras_personales'::TEXT, INITCAP(p_descripcion), FALSE;
    RETURN;
  END IF;

  -- ═══ FALLBACK ═══
  RETURN QUERY SELECT 'otro'::TEXT, INITCAP(p_descripcion), FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.categorize_personal_movement(TEXT, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC bulk upsert. Recibe array JSONB de movimientos parseados.
-- Devuelve {inserted, updated, total}.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_personal_card_movements(p_movements JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mov          JSONB;
  v_cat          RECORD;
  v_inserted     INT := 0;
  v_updated      INT := 0;
  v_total        INT := 0;
  v_was_inserted BOOLEAN;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  IF p_movements IS NULL OR jsonb_typeof(p_movements) <> 'array' THEN
    RAISE EXCEPTION 'Esperado array de movimientos' USING ERRCODE = '22023';
  END IF;

  FOR v_mov IN SELECT * FROM jsonb_array_elements(p_movements)
  LOOP
    v_total := v_total + 1;

    SELECT * INTO v_cat
      FROM public.categorize_personal_movement(
        v_mov->>'descripcion',
        COALESCE(v_mov->>'moneda', 'COP')
      );

    INSERT INTO public.personal_card_movements (
      tarjeta, marca, banco, fecha, descripcion, numero_autorizacion, monto, moneda,
      tipo, cuotas_total, cuota_numero, valor_cuota,
      interes_mensual_pct, interes_anual_pct, saldo_pendiente,
      categoria, subcategoria, es_negocio,
      periodo_corte_from, periodo_corte_to,
      origen_pdf, raw_line
    ) VALUES (
      v_mov->>'tarjeta',
      LOWER(COALESCE(v_mov->>'marca', 'mastercard')),
      COALESCE(v_mov->>'banco', 'Bancolombia'),
      (v_mov->>'fecha')::DATE,
      v_mov->>'descripcion',
      NULLIF(v_mov->>'numero_autorizacion', ''),
      (v_mov->>'monto')::NUMERIC,
      COALESCE(v_mov->>'moneda', 'COP'),
      COALESCE(v_mov->>'tipo', 'compra'),
      NULLIF(v_mov->>'cuotas_total', '')::INT,
      NULLIF(v_mov->>'cuota_numero', '')::INT,
      NULLIF(v_mov->>'valor_cuota', '')::NUMERIC,
      NULLIF(v_mov->>'interes_mensual_pct', '')::NUMERIC,
      NULLIF(v_mov->>'interes_anual_pct', '')::NUMERIC,
      NULLIF(v_mov->>'saldo_pendiente', '')::NUMERIC,
      v_cat.categoria,
      v_cat.subcategoria,
      v_cat.es_negocio,
      NULLIF(v_mov->>'periodo_corte_from', '')::DATE,
      NULLIF(v_mov->>'periodo_corte_to', '')::DATE,
      v_mov->>'origen_pdf',
      v_mov->>'raw_line'
    )
    ON CONFLICT (tarjeta, fecha, numero_autorizacion, monto, moneda, cuota_numero, periodo_corte_to)
    DO UPDATE SET
      descripcion         = EXCLUDED.descripcion,
      categoria           = EXCLUDED.categoria,
      subcategoria        = EXCLUDED.subcategoria,
      es_negocio          = EXCLUDED.es_negocio,
      cuotas_total        = EXCLUDED.cuotas_total,
      valor_cuota         = EXCLUDED.valor_cuota,
      interes_mensual_pct = EXCLUDED.interes_mensual_pct,
      interes_anual_pct   = EXCLUDED.interes_anual_pct,
      saldo_pendiente     = EXCLUDED.saldo_pendiente,
      origen_pdf          = EXCLUDED.origen_pdf,
      raw_line            = EXCLUDED.raw_line
    RETURNING (xmax = 0) INTO v_was_inserted;

    IF v_was_inserted THEN
      v_inserted := v_inserted + 1;
    ELSE
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'total',    v_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_personal_card_movements(JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: re-categorización masiva.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.recategorize_personal_movements()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT := 0;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  WITH recat AS (
    SELECT m.id, c.categoria, c.subcategoria, c.es_negocio
      FROM public.personal_card_movements m,
           LATERAL public.categorize_personal_movement(m.descripcion, m.moneda) c
  )
  UPDATE public.personal_card_movements pcm
     SET categoria    = r.categoria,
         subcategoria = r.subcategoria,
         es_negocio   = r.es_negocio
    FROM recat r
   WHERE pcm.id = r.id
     AND (pcm.categoria <> r.categoria
          OR pcm.es_negocio IS DISTINCT FROM r.es_negocio);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('updated', v_updated);
END;
$$;

GRANT EXECUTE ON FUNCTION public.recategorize_personal_movements() TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: resumen mensual por categoría.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.personal_spending_by_month(
  p_from_date DATE DEFAULT (CURRENT_DATE - INTERVAL '12 months')::DATE,
  p_to_date   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  year_month       TEXT,
  categoria        TEXT,
  es_negocio       BOOLEAN,
  total_monto      NUMERIC,
  total_count      INT,
  monto_cop        NUMERIC,
  cuotas_diferidas BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    TO_CHAR(m.fecha, 'YYYY-MM')                          AS year_month,
    m.categoria                                          AS categoria,
    BOOL_OR(m.es_negocio)                                AS es_negocio,
    SUM(m.monto)                                         AS total_monto,
    COUNT(*)::INT                                        AS total_count,
    SUM(CASE WHEN m.moneda = 'USD' THEN m.monto * 3800 ELSE m.monto END) AS monto_cop,
    COUNT(*) FILTER (WHERE m.cuotas_total IS NOT NULL AND m.cuotas_total > 1) AS cuotas_diferidas
    FROM public.personal_card_movements m
   WHERE m.fecha BETWEEN p_from_date AND p_to_date
     AND m.tipo IN ('compra', 'avance')
     AND (m.cuota_numero IS NULL OR m.cuota_numero = 1)
   GROUP BY 1, 2
   ORDER BY 1 DESC, 6 DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.personal_spending_by_month(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: top items del mes (drill-down).
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.personal_spending_top_items(
  p_year_month TEXT,
  p_categoria  TEXT DEFAULT NULL,
  p_limit      INT  DEFAULT 50
)
RETURNS TABLE (
  id                  UUID,
  fecha               DATE,
  descripcion         TEXT,
  tarjeta             TEXT,
  marca               TEXT,
  monto               NUMERIC,
  moneda              TEXT,
  monto_cop           NUMERIC,
  categoria           TEXT,
  subcategoria        TEXT,
  es_negocio          BOOLEAN,
  cuotas_total        INT,
  interes_anual_pct   NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  IF p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'year_month inválido (esperado YYYY-MM)' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    m.id,
    m.fecha,
    m.descripcion,
    m.tarjeta,
    m.marca,
    m.monto,
    m.moneda,
    CASE WHEN m.moneda = 'USD' THEN m.monto * 3800 ELSE m.monto END AS monto_cop,
    m.categoria,
    m.subcategoria,
    m.es_negocio,
    m.cuotas_total,
    m.interes_anual_pct
    FROM public.personal_card_movements m
   WHERE TO_CHAR(m.fecha, 'YYYY-MM') = p_year_month
     AND m.tipo IN ('compra', 'avance')
     AND (m.cuota_numero IS NULL OR m.cuota_numero = 1)
     AND (p_categoria IS NULL OR m.categoria = p_categoria)
   ORDER BY monto_cop DESC
   LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.personal_spending_top_items(TEXT, TEXT, INT) TO authenticated;
