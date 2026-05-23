
-- 1. Tighten address_autocomplete_cache policies (remove the "true/true ALL" policy)
DROP POLICY IF EXISTS autocomplete_cache_authenticated_all ON public.address_autocomplete_cache;

CREATE POLICY autocomplete_cache_select ON public.address_autocomplete_cache
  FOR SELECT TO authenticated USING (true);

CREATE POLICY autocomplete_cache_insert ON public.address_autocomplete_cache
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY autocomplete_cache_update ON public.address_autocomplete_cache
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
-- No DELETE policy: only the scheduled cleanup_expired_autocomplete_cache() (SECURITY DEFINER) purges.

-- 2. Add explicit INSERT policy on personal_card_movements
CREATE POLICY pcm_ins ON public.personal_card_movements
  FOR INSERT TO authenticated
  WITH CHECK (is_store_owner(store_id));

-- 3. Set search_path on functions that are missing it
ALTER FUNCTION public.categorize_personal_movement(text, text) SET search_path = public;
ALTER FUNCTION public.tg_cfo_retrospective_updated_at() SET search_path = public;
ALTER FUNCTION public.tg_monthly_ad_spend_updated_at() SET search_path = public;
ALTER FUNCTION public.tg_monthly_business_inputs_updated_at() SET search_path = public;
ALTER FUNCTION public.tg_personal_card_updated_at() SET search_path = public;
ALTER FUNCTION public.tg_tc_debt_snapshots_updated_at() SET search_path = public;

-- 4. Revoke EXECUTE from anon on all SECURITY DEFINER functions in public.
-- These are either RLS helpers (called from within policies, where role privileges
-- don't apply) or RPCs that authenticated users invoke. Anonymous users have no
-- legitimate reason to call any of them.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM anon, public;',
                   r.nspname, r.proname, r.args);
  END LOOP;
END $$;
