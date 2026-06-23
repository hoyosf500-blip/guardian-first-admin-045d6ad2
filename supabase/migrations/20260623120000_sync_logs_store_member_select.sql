-- sync_logs: permitir SELECT a los MIEMBROS de la tienda (owner/supervisor/operator),
-- no solo a admins globales.
--
-- Por qué: la frescura de ÓRDENES (banner SyncFreshness y el nuevo badge
-- OrdersSyncBadge del header de "Cómo voy") lee `sync_logs`. La card es para los
-- SOCIOS (managerOnly), pero la única policy SELECT vigente era admin-only
-- (20260413080455 / 20260427072906) → un socio veía [] y el badge/banner se
-- ocultaba (falsa sensación de "sin sync"). Esta policy lo abre por tienda.
--
-- Patrón: idéntico al de shopify_pushed_orders (20260521170000) y
-- shopify_product_dropi_map (20260522081837): USING (public.is_store_member(store_id)).
-- RLS es permisiva (OR), así que la policy admin existente se mantiene: admin O
-- miembro de la tienda pueden leer. Filas viejas con store_id NULL (pre-multitienda)
-- → is_store_member(NULL) = false → siguen admin-only (sin fuga de datos).

DROP POLICY IF EXISTS "members read store sync logs" ON public.sync_logs;
CREATE POLICY "members read store sync logs" ON public.sync_logs
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));
