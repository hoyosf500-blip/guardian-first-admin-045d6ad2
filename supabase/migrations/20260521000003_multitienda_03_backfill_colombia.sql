-- Multi-tienda SP1a — Migración 3/3: crear "Tienda Colombia", asignar dueño +
-- operadores, mover config Dropi de app_settings, backfillear store_id en las
-- 16 tablas, fijar DEFAULT al UUID centinela y SET NOT NULL.
--
-- IMPORTANTE: aplicar SOLO después de 1 y 2. Idempotente vía guards y centinela fijo.

DO $$
DECLARE
  v_store uuid := '00000000-0000-0000-0000-000000000001';  -- UUID centinela Tienda Colombia
  v_owner uuid;
BEGIN
  -- 1) Resolver el user_id del dueño por email (ver CLAUDE.md userEmail).
  SELECT id INTO v_owner FROM auth.users WHERE email = 'hoyosf500@gmail.com' LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Backfill abortado: no se encontró auth.users con email hoyosf500@gmail.com. '
      'Corregir el email o setear v_owner manualmente al user_id correcto.';
  END IF;

  -- 2) Crear la Tienda Colombia con UUID centinela (idempotente).
  INSERT INTO public.stores (id, name, country_code, status, created_by)
  VALUES (v_store, 'Rushmira (Colombia)', 'CO', 'active', v_owner)
  ON CONFLICT (id) DO NOTHING;

  -- 3) Membresías:
  --    - el dueño actual → owner
  --    - admins globales actuales → owner (hoy "admin" = control total)
  --    - operadores globales actuales → operator
  INSERT INTO public.store_members (store_id, user_id, role)
  VALUES (v_store, v_owner, 'owner')
  ON CONFLICT (store_id, user_id) DO NOTHING;

  INSERT INTO public.store_members (store_id, user_id, role)
  SELECT v_store, ur.user_id, 'owner'
  FROM public.user_roles ur
  WHERE ur.role = 'admin'
  ON CONFLICT (store_id, user_id) DO NOTHING;

  INSERT INTO public.store_members (store_id, user_id, role)
  SELECT v_store, ur.user_id, 'operator'
  FROM public.user_roles ur
  WHERE ur.role = 'operator'
    AND ur.user_id NOT IN (SELECT user_id FROM public.store_members WHERE store_id = v_store)
  ON CONFLICT (store_id, user_id) DO NOTHING;

  -- 4) Mover config Dropi global de app_settings → store_dropi_config.
  INSERT INTO public.store_dropi_config (store_id, country_code, dropi_api_key, dropi_session_token, dropi_store_url)
  VALUES (
    v_store, 'CO',
    (SELECT value FROM public.app_settings WHERE key = 'dropi_api_key'),
    (SELECT value FROM public.app_settings WHERE key = 'dropi_session_token'),
    (SELECT value FROM public.app_settings WHERE key = 'dropi_store_url')
  )
  ON CONFLICT (store_id) DO NOTHING;

  -- 5) Backfill store_id en las 16 tablas (todo lo existente es Colombia).
  UPDATE public.orders                   SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.order_results            SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.notes                    SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.touchpoints              SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.address_validations      SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.dropi_wallet_movements   SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.monthly_ad_spend         SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.monthly_business_inputs  SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.tc_debt_snapshots        SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.personal_card_movements  SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.cfo_monthly_retrospective SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.daily_reports            SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.operator_daily_reports   SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.sync_logs                SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.audit_log                SET store_id = v_store WHERE store_id IS NULL;
  UPDATE public.operator_pool            SET store_id = v_store WHERE store_id IS NULL;
END $$;

-- 6) DEFAULT al centinela para que las filas nuevas (dropi-cron, etc.) queden
--    pobladas hasta que SP2 setee store_id explícito por tienda.
ALTER TABLE public.orders                   ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.order_results            ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.notes                    ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.touchpoints              ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.address_validations      ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.dropi_wallet_movements   ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.monthly_ad_spend         ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.monthly_business_inputs  ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.tc_debt_snapshots        ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.personal_card_movements  ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.cfo_monthly_retrospective ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.daily_reports            ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.operator_daily_reports   ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.sync_logs                ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.audit_log                ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.operator_pool            ALTER COLUMN store_id SET DEFAULT '00000000-0000-0000-0000-000000000001';

-- 7) SET NOT NULL (falla en seco si quedó algún NULL → seguro).
ALTER TABLE public.orders                   ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.order_results            ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.notes                    ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.touchpoints              ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.address_validations      ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.dropi_wallet_movements   ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.monthly_ad_spend         ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.monthly_business_inputs  ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.tc_debt_snapshots        ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.personal_card_movements  ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.cfo_monthly_retrospective ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.daily_reports            ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.operator_daily_reports   ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.sync_logs                ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.audit_log                ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.operator_pool            ALTER COLUMN store_id SET NOT NULL;
