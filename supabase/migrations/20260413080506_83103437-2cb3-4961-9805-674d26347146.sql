
DROP POLICY "Service role can insert sync logs" ON public.sync_logs;

CREATE POLICY "Authenticated users can insert sync logs"
  ON public.sync_logs FOR INSERT
  TO authenticated
  WITH CHECK (triggered_by = auth.uid());
