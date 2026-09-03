-- ============================================================================
-- El día POR DEFECTO de las gestiones también es el de Bogotá
-- ============================================================================
--
-- Sigue la cacería del 3-sep-2026, después de arreglar las dos protecciones que
-- deshacían trabajo (20260903210000). Buscando más casos del mismo defecto
-- —contar "hoy" en UTC— aparecieron los valores POR DEFECTO de las dos tablas
-- donde se anota lo que hace el equipo:
--
--   order_results.result_date  DATE NOT NULL DEFAULT CURRENT_DATE
--   touchpoints.action_date    DATE NOT NULL DEFAULT CURRENT_DATE
--
-- `CURRENT_DATE` es UTC. De 19:00 a 24:00 de Bogotá, UTC ya es el día
-- SIGUIENTE: cualquier fila insertada SIN fecha en ese rato queda anotada
-- MAÑANA.
--
-- ── Quién no manda la fecha, hoy ────────────────────────────────────────────
-- Auditado call-site por call-site:
--   · Las gestiones de verdad (confirmar / cancelar / no contestó, novedades,
--     los envíos de WhatsApp de las 5 edge functions de chat) **SÍ** mandan la
--     fecha de Bogotá. Ahí no hay problema.
--   · Las filas de AUDITORÍA de edición NO la mandan: `OrderEditorDialog`
--     ('edicion_orden') y las nueve inserciones de `dropi-change-carrier`
--     ('edicion_orden' / 'cambio_valor'). Esas caen al default.
--
-- ── Por qué se arregla igual, siendo que hoy no rompe ningún número ─────────
-- Se verificó que hoy NO produce una cifra falsa: los dos lugares que comparan
-- contra "hoy" (`OrderContext`, el contador del día) filtran antes por
-- `isCallOutcome` / `result IN ('conf','canc','noresp')`, así que las filas de
-- auditoría ni siquiera llegan a la comparación. Y el panel de fallos de
-- sincronización filtra por `created_at`, no por `result_date`.
--
-- Es una MINA, no un incendio. Y está puesta justo donde va a pisar lo
-- siguiente: el dueño pidió *"más control sobre los empleados y todas las
-- acciones que marcan"*. El día que se cuenten las ediciones por fecha —que es
-- exactamente esa función— el turno de la tarde se contaría mañana, y sería un
-- número equivocado sobre el que se le habla a una persona.
--
-- Arreglar el DEFAULT tapa los dos call-sites de hoy y todos los que vengan,
-- sin depender de que nadie se acuerde. Y no necesita redesplegar ninguna edge
-- function: `dropi-change-carrier` queda arreglada sin tocarla.
--
-- ⛔ REGLA #0 — `order_results` y `touchpoints` SON tablas calientes. Pero esto
-- es lo más liviano que existe: `ALTER COLUMN ... SET DEFAULT` toca SOLO el
-- catálogo — no reescribe la tabla, no la recorre y no toca una sola fila
-- existente. Aun así va con `lock_timeout = '5s'`: si en ese instante hay una
-- transacción larga con la tabla tomada, esto FALLA RÁPIDO en vez de encolar a
-- todo el mundo detrás. Es exactamente la lección del 25-ago.
--
-- ⛔ Las filas YA escritas no se tocan. Un UPDATE masivo sobre estas dos tablas
-- es justo lo que REGLA #0 prohíbe, y reescribir el pasado borraría la
-- evidencia de cómo se anotó en su momento.
-- ============================================================================

SET lock_timeout = '5s';

ALTER TABLE public.order_results
  ALTER COLUMN result_date SET DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date);

ALTER TABLE public.touchpoints
  ALTER COLUMN action_date SET DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date);

COMMENT ON COLUMN public.order_results.result_date IS
  'Día de la gestión en hora de BOGOTÁ. El default era CURRENT_DATE (UTC), que '
  'de 19:00 a medianoche anotaba las filas de auditoría con la fecha de mañana. '
  'Ver 20260903220000.';

COMMENT ON COLUMN public.touchpoints.action_date IS
  'Día de la gestión en hora de BOGOTÁ. Mismo arreglo que order_results.result_date. '
  'Ver 20260903220000.';
