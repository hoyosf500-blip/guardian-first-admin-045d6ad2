-- Multi-tienda SP1b-1: RLS por pertenencia a la tienda (aislamiento real).
-- Reemplaza las policies "cualquiera ve todo / admin global" por policies
-- basadas en store_members. Operativas → cualquier MIEMBRO de la tienda.
-- Financieras → solo el DUEÑO de la tienda. El admin global deja de ser vía
-- de acceso cross-tenant (clave para que un operador/dueño no vea otra tienda).
--
-- IDEMPOTENTE: borra todas las policies de las 16 tablas y recrea el set nuevo.
-- Ya aplicado en producción vía SQL editor el 2026-05-21; este archivo lo deja
-- registrado en el repo. NO cambia comportamiento si se re-aplica.

DO $$
DECLARE r record;
  tt text[] := ARRAY['orders','order_results','notes','touchpoints','address_validations',
    'dropi_wallet_movements','monthly_ad_spend','monthly_business_inputs','tc_debt_snapshots',
    'personal_card_movements','cfo_monthly_retrospective','daily_reports','operator_daily_reports',
    'sync_logs','audit_log','operator_pool'];
BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname='public' AND tablename = ANY(tt) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

DO $$
DECLARE t text; tt text[] := ARRAY['orders','order_results','notes','touchpoints','address_validations',
  'dropi_wallet_movements','monthly_ad_spend','monthly_business_inputs','tc_debt_snapshots',
  'personal_card_movements','cfo_monthly_retrospective','daily_reports','operator_daily_reports',
  'sync_logs','audit_log','operator_pool'];
BEGIN
  FOREACH t IN ARRAY tt LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP;
END $$;

-- ===== OPERATIVAS (miembros de la tienda) =====
CREATE POLICY orders_sel ON public.orders FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()));
CREATE POLICY orders_ins ON public.orders FOR INSERT TO authenticated WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND uploaded_by = auth.uid());
CREATE POLICY orders_upd ON public.orders FOR UPDATE TO authenticated USING (store_id IN (SELECT public.auth_store_ids())) WITH CHECK (store_id IN (SELECT public.auth_store_ids()));

CREATE POLICY oresults_sel ON public.order_results FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()));
CREATE POLICY oresults_ins ON public.order_results FOR INSERT TO authenticated WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND operator_id = auth.uid());
CREATE POLICY oresults_del ON public.order_results FOR DELETE TO authenticated USING (store_id IN (SELECT public.auth_store_ids()) AND (operator_id = auth.uid() OR public.is_store_owner(store_id)));

CREATE POLICY notes_sel ON public.notes FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()));
CREATE POLICY notes_ins ON public.notes FOR INSERT TO authenticated WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND operator_id = auth.uid());

CREATE POLICY tp_sel ON public.touchpoints FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()));
CREATE POLICY tp_ins ON public.touchpoints FOR INSERT TO authenticated WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND operator_id = auth.uid());
CREATE POLICY tp_del ON public.touchpoints FOR DELETE TO authenticated USING (store_id IN (SELECT public.auth_store_ids()) AND (operator_id = auth.uid() OR public.is_store_owner(store_id)));

CREATE POLICY av_sel ON public.address_validations FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()));

CREATE POLICY dr_sel ON public.daily_reports FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()) AND (operator_id = auth.uid() OR public.is_store_owner(store_id)));
CREATE POLICY dr_ins ON public.daily_reports FOR INSERT TO authenticated WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND operator_id = auth.uid());

CREATE POLICY odr_sel ON public.operator_daily_reports FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()) AND (user_id = auth.uid() OR public.is_store_owner(store_id)));
CREATE POLICY odr_ins ON public.operator_daily_reports FOR INSERT TO authenticated WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND user_id = auth.uid());
CREATE POLICY odr_upd ON public.operator_daily_reports FOR UPDATE TO authenticated USING (store_id IN (SELECT public.auth_store_ids()) AND user_id = auth.uid()) WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND user_id = auth.uid());
CREATE POLICY odr_del ON public.operator_daily_reports FOR DELETE TO authenticated USING (public.is_store_owner(store_id));

CREATE POLICY op_sel ON public.operator_pool FOR SELECT TO authenticated USING (store_id IN (SELECT public.auth_store_ids()));
CREATE POLICY op_manage ON public.operator_pool FOR ALL TO authenticated USING (public.is_store_owner(store_id)) WITH CHECK (public.is_store_owner(store_id));

CREATE POLICY sl_sel ON public.sync_logs FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
CREATE POLICY sl_ins ON public.sync_logs FOR INSERT TO authenticated WITH CHECK (store_id IN (SELECT public.auth_store_ids()) AND triggered_by = auth.uid());

-- ===== FINANCIERAS (solo dueño de la tienda) =====
CREATE POLICY wallet_sel ON public.dropi_wallet_movements FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
CREATE POLICY wallet_no_write ON public.dropi_wallet_movements FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE POLICY ads_sel ON public.monthly_ad_spend FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
CREATE POLICY ads_ins ON public.monthly_ad_spend FOR INSERT TO authenticated WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY ads_upd ON public.monthly_ad_spend FOR UPDATE TO authenticated USING (public.is_store_owner(store_id)) WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY ads_del ON public.monthly_ad_spend FOR DELETE TO authenticated USING (public.is_store_owner(store_id));

CREATE POLICY mbi_sel ON public.monthly_business_inputs FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
CREATE POLICY mbi_ins ON public.monthly_business_inputs FOR INSERT TO authenticated WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY mbi_upd ON public.monthly_business_inputs FOR UPDATE TO authenticated USING (public.is_store_owner(store_id)) WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY mbi_del ON public.monthly_business_inputs FOR DELETE TO authenticated USING (public.is_store_owner(store_id));

CREATE POLICY tcd_sel ON public.tc_debt_snapshots FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
CREATE POLICY tcd_ins ON public.tc_debt_snapshots FOR INSERT TO authenticated WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY tcd_upd ON public.tc_debt_snapshots FOR UPDATE TO authenticated USING (public.is_store_owner(store_id)) WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY tcd_del ON public.tc_debt_snapshots FOR DELETE TO authenticated USING (public.is_store_owner(store_id));

CREATE POLICY pcm_sel ON public.personal_card_movements FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
CREATE POLICY pcm_upd ON public.personal_card_movements FOR UPDATE TO authenticated USING (public.is_store_owner(store_id)) WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY pcm_del ON public.personal_card_movements FOR DELETE TO authenticated USING (public.is_store_owner(store_id));

CREATE POLICY cfo_sel ON public.cfo_monthly_retrospective FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
CREATE POLICY cfo_ins ON public.cfo_monthly_retrospective FOR INSERT TO authenticated WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY cfo_upd ON public.cfo_monthly_retrospective FOR UPDATE TO authenticated USING (public.is_store_owner(store_id)) WITH CHECK (public.is_store_owner(store_id));
CREATE POLICY cfo_del ON public.cfo_monthly_retrospective FOR DELETE TO authenticated USING (public.is_store_owner(store_id));

CREATE POLICY audit_sel ON public.audit_log FOR SELECT TO authenticated USING (public.is_store_owner(store_id));
