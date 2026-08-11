DROP POLICY IF EXISTS notes_update_author ON public.notes;
CREATE POLICY notes_update_author ON public.notes
FOR UPDATE TO authenticated
USING (operator_id = auth.uid() AND store_id IN (SELECT public.auth_store_ids()))
WITH CHECK (operator_id = auth.uid() AND store_id IN (SELECT public.auth_store_ids()));

DROP POLICY IF EXISTS notes_delete_author ON public.notes;
CREATE POLICY notes_delete_author ON public.notes
FOR DELETE TO authenticated
USING (operator_id = auth.uid() AND store_id IN (SELECT public.auth_store_ids()));

DROP POLICY IF EXISTS "Users can update own results" ON public.order_results;
CREATE POLICY "Users can update own results" ON public.order_results
FOR UPDATE TO authenticated
USING (operator_id = auth.uid() AND store_id IN (SELECT public.auth_store_ids()))
WITH CHECK (operator_id = auth.uid() AND store_id IN (SELECT public.auth_store_ids()));