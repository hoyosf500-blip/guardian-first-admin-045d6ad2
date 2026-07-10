-- Las auditorías de edición/recreate FALLABAN EN SILENCIO desde que existen:
-- el CHECK original (20260413041155) solo permite ('conf','canc','noresp') y las
-- edges solo hacen console.error del insert fallido. Verificado 2026-07-10:
-- 0 filas con valores de edición en TODA la tabla + 23514 al insertar a mano.
-- Valores que insertan las edges hoy:
--   dropi-change-carrier  → 'cambio_transportadora' | 'cambio_valor' | 'edicion_completa'
--   dropi-update-order-full → 'edicion_orden'
-- Los RPCs de productividad/cierre filtran por valores explícitos ('conf','canc',
-- 'noresp'), así que los valores nuevos NO alteran ninguna métrica existente.

ALTER TABLE public.order_results DROP CONSTRAINT IF EXISTS order_results_result_check;
ALTER TABLE public.order_results ADD CONSTRAINT order_results_result_check
  CHECK (result IN (
    'conf', 'canc', 'noresp',
    'cambio_transportadora', 'cambio_valor', 'edicion_completa', 'edicion_orden'
  ));
