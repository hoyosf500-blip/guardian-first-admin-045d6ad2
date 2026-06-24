-- Ingestión del historial REAL de Dropi en order_status_history.
--
-- CONTEXTO (auditoría 2026-06-24): comparando 400 pedidos Dropi vs Guardian se
-- comprobó que Dropi guarda en promedio 8.2 estados por pedido (PENDIENTE →
-- GUIA_GENERADA → PREPARADO PARA TRANSPORTADORA → DESPACHADA → EN REPARTO → …)
-- pero Guardian solo tenía 1 (el seed del trigger forward-only). El timeline del
-- detalle de pedido salía incompleto. La causa: el mapper descartaba el campo
-- `history` que la API de Dropi YA devuelve en cada respuesta.
--
-- FIX: el sync ahora ingiere ese `history` en order_status_history. Cada entrada
-- de Dropi trae un `id` global único → lo usamos como clave de idempotencia para
-- que re-sincronizar no duplique filas.
--
-- El trigger forward-only (record_order_status_change) se MANTIENE como red de
-- seguridad: si por algún motivo la API de integraciones no trajera `history`,
-- el comportamiento actual no se rompe (cero regresión). La deduplicación de
-- "estado actual duplicado" (fila del trigger + última entrada Dropi) se hace en
-- el front (buildTimeline colapsa estados iguales consecutivos).
--
-- Índice único NO parcial: en Postgres los NULL son distintos entre sí, así que
-- las filas del trigger (dropi_history_id = NULL) conviven sin chocar, mientras
-- las filas Dropi (id no nulo) quedan únicas. Esto permite usar
-- onConflict: "dropi_history_id" desde el edge function sin predicado WHERE.

ALTER TABLE public.order_status_history
  ADD COLUMN IF NOT EXISTS dropi_history_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS uq_osh_dropi_history_id
  ON public.order_status_history (dropi_history_id);

COMMENT ON COLUMN public.order_status_history.dropi_history_id IS
  'ID de la entrada de historial en Dropi (history[].id). Clave de idempotencia para la ingestión. NULL = fila creada por el trigger local forward-only.';
