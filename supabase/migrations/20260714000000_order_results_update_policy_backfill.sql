-- ============================================================================
-- order_results: política UPDATE faltante + backfill de auditorías de edición
--
-- BUG (verificado 2026-07-13, caso Antonio Pilco #6110990): order_results
-- tiene políticas SELECT/INSERT/DELETE pero NINGUNA de UPDATE → todo settle
-- con JWT del cliente (OrderEditorDialog.settleAudit, OrderContext, el retry
-- del panel) era un no-op SILENCIOSO de 0 filas. Cada edición quedaba
-- 'pending' eterna y el panel la mostraba a los 15 min como "Edición no
-- aplicada en Dropi" AUNQUE la edición hubiera aplicado perfecta (falso
-- positivo — verificado contra el panel Dropi: #6110990 quedó único vivo con
-- la transportadora editada). Apareció ahora porque 20260710160000 amplió el
-- CHECK de result: antes esos INSERT fallaban mudos (23514) y no existían
-- filas pending que mostrar.
-- ============================================================================

-- 1) Política UPDATE: cada quien actualiza SUS filas (mismo alcance que la
--    política DELETE existente "Users can delete own results").
DROP POLICY IF EXISTS "Users can update own results" ON public.order_results;
CREATE POLICY "Users can update own results" ON public.order_results
  FOR UPDATE TO authenticated
  USING (operator_id = auth.uid())
  WITH CHECK (operator_id = auth.uid());

-- 2) Grant a nivel de COLUMNA: el cliente solo necesita settlear
--    dropi_sync_status y result_notes (verificado: TODOS los UPDATE del
--    cliente tocan solo esas dos). Sin esto, la política dejaría a una
--    operadora editar `result` de sus filas ('noresp'→'conf') e inflar
--    métricas — riesgo que la política DELETE no tenía. service_role no se
--    toca (las edge functions siguen con acceso total).
REVOKE UPDATE ON public.order_results FROM authenticated;
GRANT UPDATE (dropi_sync_status, result_notes) ON public.order_results TO authenticated;

-- 3) BACKFILL de las auditorías de edición atascadas en 'pending' por este
--    bug. (Las 'pending' de conf/canc NO se tocan: el cron ya las procesa.)

-- 3a) Evidencia dura de datos-cliente aplicados: dropi-update-order-full setea
--     orders.last_edit_sync_at SOLO tras éxito confirmado por Dropi.
UPDATE public.order_results r
SET dropi_sync_status = 'synced',
    result_notes = 'Backfill 2026-07-13: edición APLICADA (last_edit_sync_at posterior al intento). Quedó pending por bug de RLS (faltaba política UPDATE), no por fallo en Dropi.'
FROM public.orders o
WHERE r.order_id = o.id
  AND r.dropi_sync_status = 'pending'
  AND r.result IN ('cambio_transportadora','cambio_valor','edicion_completa','edicion_orden')
  AND o.last_edit_sync_at IS NOT NULL
  AND o.last_edit_sync_at >= r.created_at;

-- 3b) Evidencia de recreate aplicado: los caminos de éxito de
--     dropi-change-carrier insertan SU PROPIA auditoría server-side (default
--     dropi_sync_status='synced') segundos después de la 'pending' del
--     cliente, sobre el MISMO order_id (el dbId es estable en el recreate).
UPDATE public.order_results r
SET dropi_sync_status = 'synced',
    result_notes = 'Backfill 2026-07-13: edición APLICADA (existe auditoría server-side synced del mismo pedido posterior al intento). Quedó pending por bug de RLS.'
WHERE r.dropi_sync_status = 'pending'
  AND r.result IN ('cambio_transportadora','cambio_valor','edicion_completa','edicion_orden')
  AND EXISTS (
    SELECT 1 FROM public.order_results s
    WHERE s.order_id = r.order_id
      AND s.id <> r.id
      AND s.dropi_sync_status = 'synced'
      AND s.result IN ('cambio_transportadora','cambio_valor','edicion_completa')
      AND s.created_at >= r.created_at - interval '1 minute'
  );

-- 3c) Resto sin evidencia → 'failed' HONESTO (no fingir synced): el panel las
--     muestra con nota clara de revisión manual y no vuelven a nacer (las
--     edges settlean server-side de acá en adelante).
UPDATE public.order_results
SET dropi_sync_status = 'failed',
    result_notes = 'Backfill 2026-07-13: quedó pending por bug de RLS y SIN evidencia de aplicación — verificá en el panel de Dropi si la edición aplicó ANTES de re-aplicarla (re-aplicar puede recrear la orden).'
WHERE dropi_sync_status = 'pending'
  AND result IN ('cambio_transportadora','cambio_valor','edicion_completa','edicion_orden')
  AND created_at < now() - interval '15 minutes';
