-- FIX (regresión 2026-07-16): la Jornada dejó de guardar "En el CRM / Fuera del
-- CRM" para TODAS las operadoras.
--
-- Causa raíz: la migration 20260716144619 reescribió record_operator_heartbeat
-- para INSERTAR en `operator_activity_buckets`, una tabla que NUNCA se crea (no
-- hay CREATE TABLE en esa migration ni existe en el esquema / types.ts). Mientras
-- tanto, la lectura del dashboard (operator_activity_stats) sigue leyendo de
-- `operator_activity_daily`. Resultado: o el RPC tira "relation ... does not
-- exist" en cada flush (nada se guarda) o escribe en una tabla huérfana que nadie
-- lee → las columnas de presencia salen en blanco desde el 2026-07-16.
--
-- Fix: volver a escribir en `operator_activity_daily` (la tabla que el dashboard
-- SÍ lee) — misma lógica probada de la 20260714065341 — subiendo el clamp de 120s
-- a 300s para acompañar el flush cada 5 min del cliente (useOperatorHeartbeat.ts:
-- PING_INTERVAL_MS = 5 min). Con 120s se perdía ~60% de cada bucket de 5 min.
--
-- Sin tabla nueva, sin rollup: una sola fuente de verdad (operator_activity_daily).

CREATE OR REPLACE FUNCTION public.record_operator_heartbeat(
  p_store_id uuid,
  p_active_seconds integer,
  p_idle_seconds integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := ((NOW() AT TIME ZONE 'America/Bogota')::date);
  v_now   timestamptz := NOW();
  v_active integer;
  v_idle   integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_active_seconds < 0 OR p_idle_seconds < 0 THEN RETURN; END IF;
  -- Clamp defensivo a 300s: el cliente flushea cada 5 min (bucket máx 300s). Si
  -- vuelve tras un corte con buckets gigantes, recortamos en vez de perder todo.
  v_active := LEAST(p_active_seconds, 300);
  v_idle   := LEAST(p_idle_seconds,   300);
  IF v_active = 0 AND v_idle = 0 THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_members
                 WHERE store_id = p_store_id AND user_id = auth.uid())
    THEN RAISE EXCEPTION 'not a member of store'; END IF;

  IF v_active = 0 THEN
    -- Solo idle: acumula sin adelantar last_active_at ni crear fila "fantasma"
    -- (una operadora con la pestaña abierta sin tocar nada aún).
    UPDATE public.operator_activity_daily
      SET idle_seconds = idle_seconds + v_idle
      WHERE operator_id = auth.uid() AND store_id = p_store_id AND activity_date = v_today;
  ELSE
    INSERT INTO public.operator_activity_daily AS d (
      operator_id, store_id, activity_date, first_action_at, last_active_at, active_seconds, idle_seconds
    ) VALUES (auth.uid(), p_store_id, v_today, v_now, v_now, v_active, v_idle)
    ON CONFLICT (operator_id, store_id, activity_date) DO UPDATE
      SET active_seconds = d.active_seconds + EXCLUDED.active_seconds,
          idle_seconds   = d.idle_seconds   + EXCLUDED.idle_seconds,
          last_active_at = v_now;
  END IF;
END $function$;

GRANT EXECUTE ON FUNCTION public.record_operator_heartbeat(uuid, integer, integer) TO authenticated;
