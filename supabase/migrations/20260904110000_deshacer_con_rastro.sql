-- ============================================================================
-- Deshacer sí, borrar el expediente no: la ventana del "Deshacer"
-- ============================================================================
--
-- Auditoría del 4-sep-2026 (pedido del dueño: "más control sobre las
-- operadoras"). Las políticas DELETE de `order_results` y `touchpoints` decían
--
--   USING (operator_id = auth.uid() OR has_role(auth.uid(), 'admin'))
--
-- sin ventana de tiempo. Existen para el botón "Deshacer" de Confirmar (la
-- asesora marcó el pedido equivocado y lo revierte a los segundos). Pero con
-- esa política cualquier asesora, con su sesión y la clave anónima que viaja
-- en el bundle, podía borrar por PostgREST sus 12 cancelaciones de ayer o sus
-- "no contestó" de la semana. Y todo lo que el dueño mira —Productividad, el
-- mapa de calor, la tasa del día, el reporte diario, el sello "ya lo tocó"—
-- se calcula sobre estas dos tablas: quedaba consistente… con la versión
-- editada. Sin tombstone y sin trigger de auditoría, no había contraste.
--
-- ── Qué cambia ─────────────────────────────────────────────────────────────
-- Cada una borra SOLO lo suyo, SOLO de sus tiendas, y SOLO durante los 15
-- minutos siguientes a haberlo creado: la ventana real del "Deshacer". El
-- admin global conserva el DELETE sin ventana (limpieza de datos). Además el
-- "Deshacer" del CRM ahora deja un evento `deshizo` en `order_events`
-- (append-only, sin UPDATE ni DELETE para nadie), así "confirmó y deshizo"
-- deja de ser invisible.
--
-- ⛔ REGLA #1 — las políticas también derivan del repo. Antes de aplicar,
-- comparar con lo desplegado:
--
--   SELECT tablename, policyname, cmd, qual
--   FROM pg_policies
--   WHERE tablename IN ('order_results','touchpoints') AND cmd = 'DELETE';
--
-- Si aparece una política DELETE con otro nombre, agregarle el DROP acá antes
-- de correr esto. La nueva es estrictamente MÁS restrictiva que cualquiera de
-- las versiones conocidas (2026-04-15, 2026-04-27), así que reemplazarlas no
-- le da a nadie un permiso que no tenía.
--
-- ⛔ REGLA #0 — `order_results` y `touchpoints` son tablas calientes.
-- `CREATE POLICY` toma un lock breve sobre la tabla (no la reescribe ni la
-- recorre), pero si en ese instante hay una transacción larga con la tabla
-- tomada, esto tiene que FALLAR RÁPIDO en vez de encolar a todo el mundo
-- detrás. Por eso el lock_timeout, y por eso se aplica en un momento tranquilo.
-- ============================================================================

SET lock_timeout = '5s';

DROP POLICY IF EXISTS "Users can delete own results" ON public.order_results;
CREATE POLICY "Users can delete own results" ON public.order_results
  FOR DELETE TO authenticated
  USING (
    (
      operator_id = auth.uid()
      AND store_id IN (SELECT public.auth_store_ids())
      AND created_at > now() - interval '15 minutes'
    )
    OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
  );

DROP POLICY IF EXISTS "Users can delete own touchpoints" ON public.touchpoints;
CREATE POLICY "Users can delete own touchpoints" ON public.touchpoints
  FOR DELETE TO authenticated
  USING (
    (
      operator_id = auth.uid()
      AND store_id IN (SELECT public.auth_store_ids())
      AND created_at > now() - interval '15 minutes'
    )
    OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
  );

COMMENT ON POLICY "Users can delete own results" ON public.order_results IS
  'Solo el "Deshacer" de Confirmar: la propia fila, de la propia tienda, dentro '
  'de los 15 min de creada. Sin ventana, cualquier asesora podía borrar su '
  'expediente. Ver 20260904110000.';

COMMENT ON POLICY "Users can delete own touchpoints" ON public.touchpoints IS
  'Misma ventana de 15 min que order_results. Ver 20260904110000.';
