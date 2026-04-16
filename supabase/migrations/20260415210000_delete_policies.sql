-- Add DELETE policies for order_results and touchpoints.
-- Without these, the undoLast function in OrderContext silently fails:
-- the Supabase client returns 0 rows affected instead of an error,
-- so the UI shows "Deshecho" but the DB rows persist.

-- order_results: operators can delete their own results (undo), admins can delete any
CREATE POLICY "Users can delete own results"
  ON public.order_results
  FOR DELETE
  TO authenticated
  USING (operator_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- touchpoints: operators can delete their own touchpoints (undo cleanup)
CREATE POLICY "Users can delete own touchpoints"
  ON public.touchpoints
  FOR DELETE
  TO authenticated
  USING (operator_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
