-- Capa 1: salud por tienda
ALTER TABLE public.store_dropi_config
  ADD COLUMN IF NOT EXISTS last_health_status text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_health_checked_at timestamptz;

-- Capa 3: historial de auditorías manuales
CREATE TABLE IF NOT EXISTS public.audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  run_by uuid NOT NULL,
  guardian_count int NOT NULL DEFAULT 0,
  dropi_count int NOT NULL DEFAULT 0,
  divergences_found int NOT NULL DEFAULT 0,
  divergences_applied int NOT NULL DEFAULT 0,
  missing_in_dropi int NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.audit_runs TO authenticated;
GRANT ALL ON public.audit_runs TO service_role;

ALTER TABLE public.audit_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_runs_select ON public.audit_runs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.store_id = audit_runs.store_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','supervisor')
    )
  );

CREATE POLICY audit_runs_insert ON public.audit_runs
  FOR INSERT TO authenticated
  WITH CHECK (
    run_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.store_id = audit_runs.store_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','supervisor')
    )
  );

-- Capa 5: resultados de la reconciliación nocturna
CREATE TABLE IF NOT EXISTS public.nightly_reconcile_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  divergent_count int NOT NULL DEFAULT 0,
  applied_count int NOT NULL DEFAULT 0,
  orphan_cancelled int NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.nightly_reconcile_results TO authenticated;
GRANT ALL ON public.nightly_reconcile_results TO service_role;

ALTER TABLE public.nightly_reconcile_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY nightly_reconcile_admin_select ON public.nightly_reconcile_results
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid() AND role = 'admin')
    OR EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.store_id = nightly_reconcile_results.store_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','supervisor')
    )
  );