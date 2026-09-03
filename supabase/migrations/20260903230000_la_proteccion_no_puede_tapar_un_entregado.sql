-- ============================================================================
-- ⛔ ARREGLO DE UN ERROR PROPIO: la protección estaba tapando entregas
-- ============================================================================
--
-- Lo encontró una revisión adversarial del mismo día (3-sep-2026) sobre la
-- migración 20260903200000, escrita horas antes. Es un defecto REAL y estaba
-- vivo en la base.
--
-- ── Qué hacía mal ──────────────────────────────────────────────────────────
-- La segunda rama del disparador es:
--   OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA'
-- y **no miraba a qué estado estaba pasando**. El guard nuevo solo soltaba si
-- llegaba una novedad DISTINTA y no vacía — y un pedido que se ENTREGA llega
-- con la misma novedad (o con ninguna).
--
-- Secuencia real:
--   1. Lunes: la asesora resuelve la novedad de #1234 → 'NOVEDAD SOLUCIONADA'.
--   2. Miércoles: la transportadora lo ENTREGA. El cron sincroniza
--      estado='ENTREGADO', la novedad sin cambios.
--   3. El trigger lo revierte a 'NOVEDAD SOLUCIONADA'. Y como el upsert compara
--      con IS DISTINCT FROM, la fila SIGUE difiriendo de Dropi: cada corrida del
--      cron reescribe y el trigger revierte otra vez, hasta el día 8.
--
-- O sea: durante una semana `orders.estado` mentía sobre entregados, devueltos
-- y cancelados. Eso pega en la tasa de entrega, en /logistica, en la
-- conciliación de la wallet y en las listas con reloj. Y con un DEVUELTO es
-- peor todavía: escondía exactamente el trabajo que el comentario de la
-- migración anterior decía no querer esconder.
--
-- ── Mi responsabilidad, dicha completa ─────────────────────────────────────
-- El agujero YA existía antes de mí, pero la ventana era de UN día calendario,
-- así que solo podía pasar el mismo día de la resolución. Al abrirla a 7 días
-- multipliqué la exposición por siete. Lo escribo acá porque la próxima persona
-- que lea 20260903200000 tiene que enterarse de esto en el mismo lugar.
--
-- ── El arreglo ─────────────────────────────────────────────────────────────
-- La protección existe para UNA sola cosa: que el sync no arrastre el pedido de
-- vuelta a la COLA DE NOVEDADES. Si el pedido AVANZÓ —entregado, devuelto,
-- cancelado, en tránsito, en reparto— eso es la verdad de Dropi y no se toca.
-- Se corta antes de cualquier reposición.
--
-- Se compara con `~* 'NOVEDAD'` (cubre 'NOVEDAD' y 'NOVEDAD SOLUCIONADA', que
-- son los dos únicos estados donde esta protección tiene sentido) en vez de
-- listar los terminales: una lista de estados prohibidos se queda vieja apenas
-- Dropi inventa uno nuevo, y el que falte pasaría a estar tapado sin que nadie
-- lo note. Acá lo que falte queda AFUERA de la protección, que es el lado
-- seguro: mostrar de más se ve, esconder no.
--
-- `NEW.estado IS NULL` conserva el comportamiento anterior a propósito: no es
-- "el pedido avanzó", es "el sync no mandó estado", y ese caso ya lo cubría el
-- código viejo.
--
-- ⛔ LÍMITE CONOCIDO, que se documenta en vez de inventarle un arreglo: el
-- EXISTS cruza por TELÉFONO, no por pedido, porque `touchpoints` no guarda el
-- id del pedido (solo `phone`). Con la ventana de 7 días, un cliente que
-- resuelve la novedad de un pedido re-arma la protección de sus otros pedidos
-- ya resueltos. Acotarlo de verdad exige una columna nueva en `touchpoints` —
-- tabla caliente, o sea REGLA #0 y su propia decisión. Hoy el daño de ese
-- límite es chico: con este arreglo, un pedido que avanzó ya no se tapa.
--
-- ⛔ REGLA #1 — el cuerpo sale de la versión desplegada hoy (la de
-- 20260903200000, aplicada y verificada con `pg_get_functiondef`), y cambia una
-- sola cosa: el corte de arriba.
-- ⛔ REGLA #0 — reemplaza una función y nada más. Cero DDL sobre `orders`.
-- ============================================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.protect_resolved_novedades_bogota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- ⛔ EL PEDIDO AVANZÓ: no se toca nada. Esta protección es SOLO contra el sync
  -- que arrastra el pedido de vuelta a la cola de novedades. Un ENTREGADO, un
  -- DEVUELTO o un CANCELADO son la verdad de Dropi, y taparlos rompía la tasa
  -- de entrega y escondía devoluciones.
  IF NEW.estado IS NOT NULL AND NEW.estado !~* 'NOVEDAD' THEN
    RETURN NEW;
  END IF;

  IF (OLD.novedad_sol IS TRUE AND NEW.novedad_sol IS DISTINCT FROM TRUE)
     OR (OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA') THEN
    IF EXISTS (
      SELECT 1 FROM public.touchpoints
      WHERE phone = OLD.phone
        AND action LIKE 'NOVEDAD:%'
        AND action_date >= (NOW() AT TIME ZONE 'America/Bogota')::date - INTERVAL '7 days'
    ) THEN
      IF NEW.novedad IS NULL
         OR btrim(NEW.novedad) = ''
         OR NEW.novedad IS NOT DISTINCT FROM OLD.novedad THEN
        NEW.novedad_sol := OLD.novedad_sol;
        NEW.estado := OLD.estado;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

COMMENT ON FUNCTION public.protect_resolved_novedades_bogota() IS
  'Protege la novedad resuelta contra el sync durante 7 días, PERO solo mientras '
  'el pedido siga en un estado de novedad: si avanzó (entregado, devuelto, '
  'cancelado, en tránsito) manda Dropi y no se toca. Sin ese corte, la ventana '
  'de 7 días tapaba entregas y devoluciones durante una semana. '
  'Ver 20260903230000 y 20260903200000.';
