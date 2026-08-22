-- ============================================================================
-- Congelar la validación de la dirección EN EL MOMENTO DE DESPACHAR
--
-- ── El problema ─────────────────────────────────────────────────────────────
-- `orders.validation_decision` (el semáforo verde/amarillo/rojo de la dirección)
-- es MUTABLE: hay diez sitios que la escriben, DOS la ponen en NULL cuando se
-- edita la dirección (CallView.tsx / CrmCallView.tsx), otro la fuerza a 'green'
-- y el override de "verde viejo" reescribe el pasado.
--
-- Consecuencia medida: hoy NO se puede contestar la pregunta que decide si el
-- semáforo sirve — «de los pedidos que despaché con la dirección en rojo,
-- ¿cuántos se devolvieron?». Y el sesgo va para el lado peor: los pedidos MÁS
-- gestionados son justo los que perdieron la marca roja, así que el semáforo se
-- ve mejor de lo que es.
--
-- ── Qué hace ────────────────────────────────────────────────────────────────
-- Dos columnas nuevas que se escriben UNA sola vez, cuando aparece la guía (o
-- sea, al despachar), y no se vuelven a tocar nunca. Es un sello, no un espejo.
--
-- ⛔ REGLA #1: NO se reescribe ninguna función viva. Todo acá es ADITIVO —
-- columnas nuevas y un trigger nuevo con nombre propio. `upsert_orders_from_dropi`
-- no se toca ni se copia.
--
-- ── Lo que NO hace: backfill ────────────────────────────────────────────────
-- El histórico queda en NULL A PROPÓSITO. Rellenar con el valor de HOY y
-- estamparlo como "lo que había al despachar" sería inventar el dato — que es
-- exactamente el defecto que esta migración viene a arreglar. Mismo criterio que
-- `orders.last_synced_at`: los que quedan en NULL son la lista de los que se
-- despacharon antes de que existiera el sello, y eso se puede decir en voz alta.
-- ============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS validacion_al_despachar text,
  ADD COLUMN IF NOT EXISTS address_kind_al_despachar text,
  ADD COLUMN IF NOT EXISTS validacion_sellada_at timestamptz;

COMMENT ON COLUMN public.orders.validacion_al_despachar IS
  'Semáforo de la dirección EN EL MOMENTO de generarse la guía. Inmutable: se '
  'escribe una vez y no se vuelve a tocar. NULL con validacion_sellada_at NO nulo '
  'significa "se despachó SIN validar" — que es un dato, no un vacío.';

COMMENT ON COLUMN public.orders.validacion_sellada_at IS
  'Cuándo se selló. NULL = todavía no se despachó, o se despachó antes de que '
  'existiera el sello (histórico, sin backfill a propósito).';

-- Índice parcial: las consultas de análisis siempre filtran por "ya sellado".
CREATE INDEX IF NOT EXISTS orders_validacion_sellada_idx
  ON public.orders (store_id, validacion_al_despachar)
  WHERE validacion_sellada_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sellar_validacion_al_despachar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ya sellado: no se toca NUNCA. Es la propiedad entera de esta columna — si
  -- se pudiera reescribir, sería otro espejo mutable y no serviría de nada.
  IF NEW.validacion_sellada_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- El sello es al DESPACHAR = cuando aparece la guía por primera vez.
  IF NEW.guia IS NOT NULL AND btrim(NEW.guia) <> ''
     AND (TG_OP = 'INSERT' OR OLD.guia IS NULL OR btrim(OLD.guia) = '')
  THEN
    -- Puede quedar NULL, y está bien: quiere decir que se despachó sin que
    -- nadie validara la dirección. `validacion_sellada_at` distingue ese caso
    -- de "todavía no se despachó" — cero nunca sustituye a "no se pudo medir".
    NEW.validacion_al_despachar  := NEW.validation_decision;
    NEW.address_kind_al_despachar := NEW.address_kind;
    NEW.validacion_sellada_at    := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sellar_validacion_al_despachar ON public.orders;
CREATE TRIGGER trg_sellar_validacion_al_despachar
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.sellar_validacion_al_despachar();
