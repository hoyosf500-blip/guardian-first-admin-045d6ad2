-- Observabilidad del nightly-reconcile (2026-07-03).
-- Problema: el fail-safe del barrido de borrados (pull incompleto por throttle
-- EC) era INVISIBLE — orphan_cancelled=0 podía significar "todo limpio" o
-- "no pude verificar". El mismo punto ciego del cron zombie de mayo.
-- Además los cancels del nightly eran irrastreables (orders no tiene updated_at).

ALTER TABLE public.nightly_reconcile_results
  ADD COLUMN IF NOT EXISTS deleted_check_complete boolean,
  ADD COLUMN IF NOT EXISTS dropi_created_count integer,
  ADD COLUMN IF NOT EXISTS cancelled_external_ids jsonb;

COMMENT ON COLUMN public.nightly_reconcile_results.deleted_check_complete IS
  '¿El barrido por FECHA DE CREADO fue confiable? true=verificado contra Dropi; false=fail-safe (throttle, NO se pudo verificar); null=sin candidatos o corrida pre-migration.';
COMMENT ON COLUMN public.nightly_reconcile_results.dropi_created_count IS
  'Cantidad de pedidos que devolvió el pull completo por FECHA DE CREADO (ventana 30d).';
COMMENT ON COLUMN public.nightly_reconcile_results.cancelled_external_ids IS
  'Auditoría: {orphans: [external_ids <5M], deleted: [external_ids borrados en Dropi]} cancelados en esta corrida.';