-- ============================================================================
-- Dos protecciones que deshacían trabajo en silencio
-- ============================================================================
--
-- Salieron de la cacería que pidió el dueño el 3-sep-2026, después de arreglar
-- la novedad que volvía cada mañana (20260903200000). Buscando "más bugs de esa
-- clase" aparecieron dos, y la segunda no la estaba buscando.
--
-- ⛔ REGLA #1 — los dos cuerpos salen de `pg_get_functiondef` pedido ese mismo
-- día, NO del repo (que ya mintió dos veces en esta sesión: la función de
-- novedades ni siquiera se llamaba igual). De cada uno se cambia UNA cosa.
--
-- ⛔ REGLA #0 — esto reemplaza dos funciones y nada más: cero ALTER, cero
-- índices, cero UPDATE masivo sobre `orders`. Los dos triggers ya existen y ya
-- apuntan acá, así que tampoco se tocan.
--
--
-- ── 1. `protect_confirmed_orders` — la hermana con el mismo defecto ─────────
--
-- Tenía LA MISMA ventana de un día calendario que la de novedades:
--   `result_date = (now() AT TIME ZONE 'America/Bogota')::date`
--
-- Qué pasaba, en la pantalla que más se usa:
--   1. La asesora confirma. Dropi NO acepta (pedido del bot, red caída, o Dropi
--      lento). Guardian guarda la confirmación igual y la reintenta cada 5 min
--      — eso está BIEN hecho y no se toca.
--   2. Si Dropi sigue sin aceptarla, al día siguiente la protección se vence.
--   3. El sync repone `PENDIENTE CONFIRMACION` y el pedido VUELVE a la cola de
--      Confirmar → la asesora LLAMA DE NUEVO a un cliente que ya confirmó ayer.
--
-- Y con los pedidos del bot de Dropi es peor: esos se excluyen del reintento a
-- propósito (prefijo BOT-SIN-API, porque la API nunca los va a aceptar), así
-- que volvían a la cola TODOS LOS DÍAS, para siempre.
--
-- La falla NO se esconde: sigue viéndose en el panel de fallos de sincronización
-- (`order_results.dropi_sync_status='failed'`), que es donde hay que atenderla
-- — en el panel de Dropi, no llamando otra vez al cliente.
--
-- Se abre a 7 días, la misma vara que la de novedades. Acotada a propósito: si
-- después de una semana la confirmación nunca llegó a Dropi, que vuelva a la
-- cola es lo correcto — a esa altura el pedido ya se canceló solo del lado de
-- Dropi y hay que rehacerlo de verdad.
--
--
-- ── 2. `protect_fecha_conf_freeze` — el día que se cuenta en UTC ────────────
--
-- Esta NO la estaba buscando. Calcula los días desde la confirmación con
-- `CURRENT_DATE`, que en Postgres es **UTC**, no Bogotá.
--
-- Es EXACTAMENTE el bug que la migración 20260714140000 arregló en los otros
-- dos triggers de protección — y a este lo dejó afuera. Su propio texto lo
-- explica: *"entre las 19:00 y la medianoche de Bogotá, UTC ya es el día
-- SIGUIENTE"*.
--
-- Consecuencia medible: **de 19:00 a 24:00 hora de Bogotá, `dias_conf` sale un
-- día de más en TODOS los pedidos confirmados.** Y como este trigger corre en
-- cada actualización de la fila, el número sube a la tarde y vuelve a bajar a
-- la mañana siguiente: el mismo pedido dice 3 días y después 2.
--
-- Ese número no es decorativo — es el reloj con el que la operación decide:
-- los tramos "urgente (D4-6)" y "cancelar (D7+)" de Confirmar salen de ahí, y
-- un pedido sin confirmar se cancela solo a los 4 días. En el turno de la tarde
-- el equipo veía pedidos un día más viejos de lo que eran, y cancelaba un día
-- antes de tiempo.
--
-- Fix: la misma fecha que usa el cliente (`bogotaToday()`) y que ya usan las
-- otras dos protecciones.
-- ============================================================================

SET lock_timeout = '5s';

-- ── 1 ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_confirmed_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.estado = 'PENDIENTE CONFIRMACION' AND OLD.estado IS DISTINCT FROM 'PENDIENTE CONFIRMACION' THEN
    IF EXISTS (SELECT 1 FROM public.order_results
      WHERE order_id = OLD.id AND result = 'conf'
        -- Antes: `= hoy`. Con el push a Dropi fallando, al día siguiente el
        -- pedido volvía a la cola y la asesora llamaba de nuevo a un cliente
        -- que ya había confirmado. La falla se atiende en el panel de fallos,
        -- no repitiendo la llamada.
        AND result_date >= (now() AT TIME ZONE 'America/Bogota')::date - INTERVAL '7 days') THEN
      NEW.estado := OLD.estado;
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

COMMENT ON FUNCTION public.protect_confirmed_orders() IS
  'Protege la confirmación contra el próximo sync durante 7 días (antes: 1 día '
  'calendario, y por eso un pedido cuyo push a Dropi falló volvía a la cola al '
  'otro día y se le llamaba de nuevo al cliente). La falla sigue visible en el '
  'panel de fallos de sincronización. Ver 20260903210000.';

-- ── 2 ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_fecha_conf_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.fecha_conf IS NOT NULL AND OLD.fecha_conf <> '' THEN
    NEW.fecha_conf := OLD.fecha_conf;
    IF OLD.fecha_conf ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      -- Antes: CURRENT_DATE, que es UTC. De 19:00 a 24:00 de Bogotá, UTC ya es
      -- el día siguiente y `dias_conf` salía un día de más en TODOS los pedidos
      -- confirmados — el reloj con el que se decide "urgente (D4-6)" y
      -- "cancelar (D7+)". Misma fecha que usa el cliente y que ya usan las
      -- otras dos protecciones (ver 20260714140000, que dejó esta afuera).
      NEW.dias_conf := GREATEST(0, ((now() AT TIME ZONE 'America/Bogota')::date - OLD.fecha_conf::date));
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

COMMENT ON FUNCTION public.protect_fecha_conf_freeze() IS
  'Congela fecha_conf y recalcula dias_conf con la fecha de BOGOTÁ (antes: '
  'CURRENT_DATE = UTC, que de 19:00 a medianoche sumaba un día de más a todos '
  'los pedidos confirmados y adelantaba los tramos D4-6 / D7+). Ver 20260903210000.';
