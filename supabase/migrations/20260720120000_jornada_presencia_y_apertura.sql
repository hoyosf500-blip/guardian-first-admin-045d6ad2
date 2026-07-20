-- Jornada: que "SALIÓ" deje de mentir, y que la APERTURA vuelva a Reportes diarios.
--
-- Queja del dueño (2026-07-20): "Productividad no marca nada, peor si están
-- trabajando" + "en Reportes diarios no me sale la apertura ni el cierre".
--
-- ════ LO QUE SE MIDIÓ EN PRODUCCIÓN ANTES DE TOCAR NADA ════
--
-- operator_activity_daily, últimos días, comparando el span (primera→última
-- señal) contra lo REGISTRADO (active_seconds + idle_seconds):
--
--     20-jul  ROBERTO   span 307 min  →  registrado  26 min   (8%)
--     19-jul  ROBERTO   span 682 min  →  registrado 153 min  (22%)
--     16-jul  ROBERTO   span  91 min  →  registrado  11 min  (12%)
--     19-jul  otra op   span 162 min  →  registrado 136 min  (84%)
--     16-jul  otra op   span  99 min  →  registrado  96 min  (97%)
--
-- El faltante no está en activo NI en quieto: nunca se registró. La causa vive
-- en el cliente (el tick contaba ejecuciones de un setInterval que Chrome
-- throttlea a 1/minuto en pestañas de fondo) y se arregla en
-- useOperatorHeartbeat.ts midiendo tiempo de RELOJ. Esta migración arregla las
-- tres cosas que dependen del servidor.
--
-- ════ 1. last_active_at AVANZA SIEMPRE ════
--
-- Antes, la rama `IF v_active = 0` sumaba idle pero NO tocaba last_active_at.
-- Esa columna alimenta "SALIÓ" y "desconectada hace X". Resultado: una
-- operadora presente con el CRM de fondo —atendiendo por teléfono, que es el
-- trabajo— quedaba marcada como que se fue a la hora en que movió el mouse por
-- última vez. El 20-jul mostraba "Salió 12:27 p.m." a alguien conectado.
--
-- last_active_at pasa a significar ÚLTIMA SEÑAL (seguimos oyendo al navegador),
-- que es exactamente como ya la leen "Salió" y "en línea". active_seconds sigue
-- midiendo aparte el mouse real, así que no se pierde ninguna señal.
--
-- Esto además respeta lo que el propio panel promete y no cumplía: "NO se
-- descuenta el estar quieta — puede estar en una llamada".
--
-- ════ 2. TECHO 300s → 900s ════
--
-- Con el tick por reloj un bucket normal de 5 min trae ~300s. Si el navegador
-- atrasa el flush, el bucket llega más gordo y con el techo viejo se truncaba
-- justo el tiempo que acabamos de recuperar. 900s da aire sin dejar pasar un
-- PC que estuvo dormido (eso ya lo corta el cliente por tick).
--
-- ════ 3. APERTURA AUTOMÁTICA ════
--
-- REGRESIÓN PROPIA, dicha sin adorno: al quitar el formulario de apertura
-- (commit 2f85c7c, 19-jul) nadie volvió a llamar submit_opening_report. La
-- última apertura registrada es del 18-jul; desde entonces la tabla "Apertura y
-- cierre por operadora" no tiene ninguna fila de apertura.
--
-- Ahora la sella el mismo latido que ya marca la hora de entrada: abrir el CRM
-- ES la apertura. Se usa COALESCE para conservar la PRIMERA del día — volver a
-- entrar no la reescribe, que es justo lo que el dueño pidió blindar ayer.
--
-- Las columnas que llenaba el formulario (pedidos nuevos, guías de ayer,
-- pendientes de ayer) siguen vacías: ese dato ya no se recoge y no se va a
-- inventar. La hora, que es lo que se pidió, sí queda.
--
-- NO SE TOCA el cierre. Se verificó que funciona (el último es del 19-jul
-- 11:48) y que pending_retry_list NO lo está bloqueando. Sigue siendo manual:
-- si nadie aprieta "Cerrar turno", ese día no tiene cierre.

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
  -- Techo defensivo (ver bloque 2 del encabezado).
  v_active := LEAST(p_active_seconds, 900);
  v_idle   := LEAST(p_idle_seconds,   900);
  IF v_active = 0 AND v_idle = 0 THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_members
                 WHERE store_id = p_store_id AND user_id = auth.uid())
    THEN RAISE EXCEPTION 'not a member of store'; END IF;

  IF v_active = 0 THEN
    -- Solo quieto: acumula idle Y adelanta la última señal. Estar quieta no es
    -- haberse ido — puede estar en una llamada.
    UPDATE public.operator_activity_daily
      SET idle_seconds   = idle_seconds + v_idle,
          last_active_at = v_now
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

  -- APERTURA. Idempotente por diseño: COALESCE conserva la primera hora del
  -- día, así que recargar o volver a entrar NO la reescribe.
  INSERT INTO public.operator_daily_reports AS r (
    user_id, store_id, report_date, opening_at
  ) VALUES (auth.uid(), p_store_id, v_today, v_now)
  ON CONFLICT (user_id, report_date) DO UPDATE
    SET opening_at = COALESCE(r.opening_at, EXCLUDED.opening_at);
END $function$;

GRANT EXECUTE ON FUNCTION public.record_operator_heartbeat(uuid, integer, integer) TO authenticated;
