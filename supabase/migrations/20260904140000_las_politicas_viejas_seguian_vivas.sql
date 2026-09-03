-- ============================================================================
-- Las políticas DELETE viejas seguían vivas: la ventana de 15 min no valía
-- ============================================================================
--
-- Qué pasó (4-sep-2026): `20260904110000_deshacer_con_rastro.sql` hacía
-- `DROP POLICY IF EXISTS "Users can delete own results"` — el nombre que tenía
-- la política en el REPO. En la base, el precheck de `pg_policies` mostró que
-- las políticas DELETE desplegadas se llaman `oresults_del` y `tp_del`:
--
--   store_id IN (SELECT auth_store_ids())
--   AND (operator_id = auth.uid() OR is_store_owner(store_id))
--
-- El DROP no encontró nada, el CREATE agregó una SEGUNDA política, y como las
-- políticas de Postgres son PERMISSIVE por defecto, se combinan con OR: la
-- vieja seguía dejando borrar lo propio sin ventana de tiempo. La migración
-- anterior quedó aplicada y sin efecto. REGLA #1, otra vez: el repo no es la
-- base, ni siquiera para los nombres.
--
-- Qué hace esta: suelta las dos viejas y deja UNA política DELETE por tabla,
-- con lo que la desplegada permitía (tienda propia; el owner de la tienda
-- conserva el DELETE, como hoy) más la ventana de 15 minutos para la asesora.
-- Todo lo que borra el CRM son filas propias de hace segundos (rollback al
-- fallar el push a Dropi y el botón "Deshacer" de Confirmar): nada queda afuera.
--
-- Verificar después (tiene que salir UNA fila por tabla):
--
--   SELECT tablename, policyname, qual FROM pg_policies
--   WHERE tablename IN ('order_results','touchpoints') AND cmd = 'DELETE';
--
-- ⛔ REGLA #0 — tablas calientes: lock_timeout y momento tranquilo.
-- ============================================================================

SET lock_timeout = '5s';

DROP POLICY IF EXISTS oresults_del ON public.order_results;
DROP POLICY IF EXISTS "Users can delete own results" ON public.order_results;
CREATE POLICY "Users can delete own results" ON public.order_results
  FOR DELETE TO authenticated
  USING (
    store_id IN (SELECT public.auth_store_ids())
    AND (
      (operator_id = auth.uid() AND created_at > now() - interval '15 minutes')
      OR public.is_store_owner(store_id)
      OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
    )
  );

DROP POLICY IF EXISTS tp_del ON public.touchpoints;
DROP POLICY IF EXISTS "Users can delete own touchpoints" ON public.touchpoints;
CREATE POLICY "Users can delete own touchpoints" ON public.touchpoints
  FOR DELETE TO authenticated
  USING (
    store_id IN (SELECT public.auth_store_ids())
    AND (
      (operator_id = auth.uid() AND created_at > now() - interval '15 minutes')
      OR public.is_store_owner(store_id)
      OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
    )
  );
