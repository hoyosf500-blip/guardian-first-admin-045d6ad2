-- Tanda 3 — fixes de lógica de negocio
-- H5: trigger que congela fecha_conf — Dropi reescribía el SLA de Rescate
-- H8: UNIQUE en touchpoints para evitar duplicados por doble-click

-- ─────────────────────────────────────────────────────────────────
-- H5: protect_fecha_conf_freeze
-- ─────────────────────────────────────────────────────────────────
-- Antes: dropi-sync/dropi-cron mapean `fecha_conf = updated_at` para
-- cualquier estado distinto a PENDIENTE CONFIRMACION. Eso significa
-- que CUALQUIER edición del pedido en Dropi (corregir dirección,
-- cambiar bodega, lo que sea) actualiza updated_at y reescribe
-- fecha_conf. Un pedido confirmado hace 5 días que Dropi tocó hoy
-- aparece como "0 días confirmado" y desaparece de Rescate D5+.
--
-- Ahora: trigger BEFORE UPDATE preserva fecha_conf y dias_conf si
-- el pedido ya tenía fecha_conf seteada (la primera transición).
-- INSERTs no se afectan: el primer fecha_conf que llegue queda fijo.
-- dias_conf se recalcula contra CURRENT_DATE para mantener consistencia.
CREATE OR REPLACE FUNCTION public.protect_fecha_conf_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.fecha_conf IS NOT NULL AND OLD.fecha_conf <> '' THEN
    -- Preservar el primer fecha_conf observado.
    NEW.fecha_conf := OLD.fecha_conf;
    -- Recalcular dias_conf contra hoy si el formato es ISO YYYY-MM-DD.
    IF OLD.fecha_conf ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      NEW.dias_conf := GREATEST(0, (CURRENT_DATE - OLD.fecha_conf::date));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_fecha_conf_freeze ON public.orders;
CREATE TRIGGER trg_protect_fecha_conf_freeze
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_fecha_conf_freeze();

-- ─────────────────────────────────────────────────────────────────
-- H8: UNIQUE en touchpoints — evita doble-click duplicado
-- ─────────────────────────────────────────────────────────────────
-- Antes: nada impedía que un doble-click justo en el límite del
-- minuto, o un realtime push + click rápido, insertara dos
-- touchpoints idénticos. Eso infla SegRescueCounterBar (tanto
-- "myActions" como "teamActions") y la tasa de Resolución %.
--
-- Ahora: UNIQUE en (operator_id, phone, action, action_date,
-- action_time). NULLs en action_time se siguen permitiendo (Postgres
-- trata NULL ≠ NULL en uniqueness) — son touchpoints sin temporalidad
-- fina y suelen venir de imports antiguos.
--
-- Si hay duplicados existentes esta migración fallará. Si pasa:
--   DELETE FROM public.touchpoints t1 USING public.touchpoints t2
--   WHERE t1.id < t2.id
--     AND t1.operator_id = t2.operator_id AND t1.phone = t2.phone
--     AND t1.action = t2.action AND t1.action_date = t2.action_date
--     AND t1.action_time IS NOT DISTINCT FROM t2.action_time;
CREATE UNIQUE INDEX IF NOT EXISTS touchpoints_dedup
  ON public.touchpoints (operator_id, phone, action, action_date, action_time);
