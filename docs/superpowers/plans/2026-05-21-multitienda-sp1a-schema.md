# Multi-tienda SP1a — Schema + Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introducir el eje de tenencia (`stores` / `store_members` / `store_dropi_config` + helpers RLS) y agregar `store_id` poblado a las 16 tablas tenant, SIN cambiar comportamiento ni aislamiento todavía.

**Architecture:** Migraciones SQL puramente **aditivas**. Se crea la "Tienda Colombia (Rushmira)" con un UUID centinela fijo, se asigna al dueño y operadores actuales, se mueve la config Dropi de `app_settings` a `store_dropi_config`, y se backfillea `store_id` en todas las filas existentes. Una columna `DEFAULT` apuntando al UUID centinela garantiza que las filas nuevas (que siguen entrando por `dropi-cron` cada 5 min) queden con `store_id` poblado, permitiendo `SET NOT NULL`. El RLS de las tablas existentes NO se toca en SP1a (eso es SP1b).

**Tech Stack:** Supabase Postgres (migraciones en `supabase/migrations/`), RLS, funciones PL/pgSQL `SECURITY DEFINER`. **No hay Supabase CLI local** — las migraciones se aplican vía Lovable y se verifican en el SQL Editor del dashboard de Supabase.

---

## Contexto operativo crítico (leer antes de empezar)

- **No se puede `supabase db push` desde acá.** Cada migración es un archivo nuevo en `supabase/migrations/` que se commitea y luego **se aplica pidiéndoselo a Lovable** ("aplicá las migraciones nuevas"). Hasta que Lovable las corra, NO tienen efecto en la base en vivo.
- **Base en producción con datos reales (plata).** Las 3 migraciones son aditivas y reversibles, pero el orden importa: A → B → C. No aplicar C antes que A y B.
- **`dropi-cron` corre cada 5 min** insertando órdenes nuevas SIN `store_id` (la edge function se actualiza recién en SP2). Por eso C define un `DEFAULT` al UUID centinela: las órdenes nuevas caen automáticamente en la Tienda Colombia y `NOT NULL` se sostiene.
- **Verificación:** no hay `psql`. Cada tarea de verificación se corre en **Supabase Dashboard → SQL Editor** (sesión admin). Se incluye el SQL y el resultado esperado.
- **Branch:** trabajar en una rama (`feat/multitienda-sp1a`), no en `main`.
- **UUID centinela de la primera tienda:** `00000000-0000-0000-0000-000000000001` (constante, referenciable en `DEFAULT`).

## Las 16 tablas tenant (orden canónico usado en todo el plan)

`orders`, `order_results`, `notes`, `touchpoints`, `address_validations`, `dropi_wallet_movements`, `monthly_ad_spend`, `monthly_business_inputs`, `tc_debt_snapshots`, `personal_card_movements`, `cfo_monthly_retrospective`, `daily_reports`, `operator_daily_reports`, `sync_logs`, `audit_log`, `operator_pool`.

## File Structure

- Create: `supabase/migrations/20260521000001_multitienda_01_core_tables.sql` — tablas nuevas, helpers RLS, RLS de las tablas nuevas.
- Create: `supabase/migrations/20260521000002_multitienda_02_store_id_columns.sql` — `store_id` (nullable) + índices en las 16 tablas.
- Create: `supabase/migrations/20260521000003_multitienda_03_backfill_colombia.sql` — crear tienda + miembros + config Dropi, backfill, `DEFAULT`, `SET NOT NULL`.
- Modify: `PROGRESS.md` — registrar SP1a aplicado.
- (NO se toca `src/` ni `types.ts` en SP1a — la app no consume `store_id` todavía. Eso es SP1c.)

---

### Task 1: Migración A — tablas núcleo + helpers RLS

**Files:**
- Create: `supabase/migrations/20260521000001_multitienda_01_core_tables.sql`

- [ ] **Step 1: Escribir la migración A**

```sql
-- Multi-tienda SP1a — Migración 1/3: tablas núcleo + helpers RLS.
-- Puramente aditiva. No toca tablas existentes.

-- ── Tabla stores: la unidad de tenencia ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.stores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  country_code text NOT NULL DEFAULT 'CO' CHECK (country_code ~ '^[A-Z]{2}$'),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Tabla store_members: pertenencia + rol por tienda ───────────────
CREATE TABLE IF NOT EXISTS public.store_members (
  store_id   uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_store_members_user ON public.store_members(user_id);

-- ── Tabla store_dropi_config: credenciales + país por tienda ────────
CREATE TABLE IF NOT EXISTS public.store_dropi_config (
  store_id             uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  country_code         text NOT NULL DEFAULT 'CO',
  dropi_api_key        text,
  dropi_session_token  text,
  dropi_store_url      text,
  white_brand_id       text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── Helpers RLS (SECURITY DEFINER → saltan RLS de store_members,
--    evitando recursión cuando las políticas los invocan) ───────────
CREATE OR REPLACE FUNCTION public.auth_store_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT store_id FROM public.store_members WHERE user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.is_store_member(p_store_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id
) $$;

CREATE OR REPLACE FUNCTION public.store_role(p_store_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT role FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id $$;

CREATE OR REPLACE FUNCTION public.is_store_owner(p_store_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id AND role = 'owner'
) $$;

-- ── RLS de las tablas nuevas ────────────────────────────────────────
ALTER TABLE public.stores             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_dropi_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stores_member_select" ON public.stores;
CREATE POLICY "stores_member_select" ON public.stores
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.auth_store_ids()));

DROP POLICY IF EXISTS "stores_owner_update" ON public.stores;
CREATE POLICY "stores_owner_update" ON public.stores
  FOR UPDATE TO authenticated
  USING (public.is_store_owner(id))
  WITH CHECK (public.is_store_owner(id));

DROP POLICY IF EXISTS "members_select" ON public.store_members;
CREATE POLICY "members_select" ON public.store_members
  FOR SELECT TO authenticated
  USING (store_id IN (SELECT public.auth_store_ids()));

DROP POLICY IF EXISTS "members_owner_manage" ON public.store_members;
CREATE POLICY "members_owner_manage" ON public.store_members
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

DROP POLICY IF EXISTS "dropi_config_owner_manage" ON public.store_dropi_config;
CREATE POLICY "dropi_config_owner_manage" ON public.store_dropi_config
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260521000001_multitienda_01_core_tables.sql
git commit -m "feat(multitienda): migración 1 — tablas stores/store_members/store_dropi_config + helpers RLS"
```

- [ ] **Step 3: Aplicar vía Lovable**

Pedir a Lovable: *"Aplicá la migración `20260521000001_multitienda_01_core_tables.sql`"*. Esperar confirmación de que corrió sin error.

- [ ] **Step 4: Verificar (Supabase Dashboard → SQL Editor)**

```sql
SELECT tablename FROM pg_tables
WHERE schemaname='public' AND tablename IN ('stores','store_members','store_dropi_config')
ORDER BY tablename;
```
Esperado: 3 filas (`store_dropi_config`, `store_members`, `stores`).

```sql
SELECT proname FROM pg_proc
WHERE proname IN ('auth_store_ids','is_store_member','store_role','is_store_owner')
ORDER BY proname;
```
Esperado: 4 filas.

---

### Task 2: Migración B — columnas `store_id` + índices

**Files:**
- Create: `supabase/migrations/20260521000002_multitienda_02_store_id_columns.sql`

- [ ] **Step 1: Escribir la migración B**

```sql
-- Multi-tienda SP1a — Migración 2/3: store_id (nullable) + índices.
-- Aditiva. NO toca RLS de estas tablas (eso es SP1b).

ALTER TABLE public.orders                   ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.order_results            ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.notes                    ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.touchpoints              ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.address_validations      ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.dropi_wallet_movements   ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.monthly_ad_spend         ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.monthly_business_inputs  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.tc_debt_snapshots        ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.personal_card_movements  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.cfo_monthly_retrospective ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.daily_reports            ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.operator_daily_reports   ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.sync_logs                ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.audit_log                ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.operator_pool            ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

CREATE INDEX IF NOT EXISTS idx_orders_store                   ON public.orders(store_id);
CREATE INDEX IF NOT EXISTS idx_order_results_store            ON public.order_results(store_id);
CREATE INDEX IF NOT EXISTS idx_notes_store                    ON public.notes(store_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_store              ON public.touchpoints(store_id);
CREATE INDEX IF NOT EXISTS idx_address_validations_store      ON public.address_validations(store_id);
CREATE INDEX IF NOT EXISTS idx_dropi_wallet_movements_store   ON public.dropi_wallet_movements(store_id);
CREATE INDEX IF NOT EXISTS idx_monthly_ad_spend_store         ON public.monthly_ad_spend(store_id);
CREATE INDEX IF NOT EXISTS idx_monthly_business_inputs_store  ON public.monthly_business_inputs(store_id);
CREATE INDEX IF NOT EXISTS idx_tc_debt_snapshots_store        ON public.tc_debt_snapshots(store_id);
CREATE INDEX IF NOT EXISTS idx_personal_card_movements_store  ON public.personal_card_movements(store_id);
CREATE INDEX IF NOT EXISTS idx_cfo_monthly_retrospective_store ON public.cfo_monthly_retrospective(store_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_store            ON public.daily_reports(store_id);
CREATE INDEX IF NOT EXISTS idx_operator_daily_reports_store   ON public.operator_daily_reports(store_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_store                ON public.sync_logs(store_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_store                ON public.audit_log(store_id);
CREATE INDEX IF NOT EXISTS idx_operator_pool_store            ON public.operator_pool(store_id);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260521000002_multitienda_02_store_id_columns.sql
git commit -m "feat(multitienda): migración 2 — columna store_id + índices en 16 tablas tenant"
```

- [ ] **Step 3: Aplicar vía Lovable**

Pedir a Lovable: *"Aplicá la migración `20260521000002`"*. Esperar confirmación.

- [ ] **Step 4: Verificar (SQL Editor)**

```sql
SELECT count(*) AS tablas_con_store_id
FROM information_schema.columns
WHERE table_schema='public' AND column_name='store_id'
  AND table_name IN ('orders','order_results','notes','touchpoints','address_validations',
    'dropi_wallet_movements','monthly_ad_spend','monthly_business_inputs','tc_debt_snapshots',
    'personal_card_movements','cfo_monthly_retrospective','daily_reports','operator_daily_reports',
    'sync_logs','audit_log','operator_pool');
```
Esperado: `16`.

---

### Task 3: Migración C — crear tienda + miembros + config + backfill + NOT NULL

**Files:**
- Create: `supabase/migrations/20260521000003_multitienda_03_backfill_colombia.sql`

- [ ] **Step 1: Escribir la migración C**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260521000003_multitienda_03_backfill_colombia.sql
git commit -m "feat(multitienda): migración 3 — tienda Colombia + miembros + config Dropi + backfill store_id + NOT NULL"
```

- [ ] **Step 3: Aplicar vía Lovable**

Pedir a Lovable: *"Aplicá la migración `20260521000003`"*. Si falla con "column store_id contains null values" en alguna tabla, significa que entraron filas nuevas entre B y C sin default — re-correr la migración (es idempotente: el `DEFAULT` ya estará puesto y el `UPDATE ... WHERE store_id IS NULL` limpia los rezagados).

- [ ] **Step 4: Verificar dueño y membresías (SQL Editor)**

```sql
SELECT s.name, s.country_code, sm.role, count(*) OVER () AS total_miembros
FROM public.stores s
JOIN public.store_members sm ON sm.store_id = s.id
WHERE s.id = '00000000-0000-0000-0000-000000000001';
```
Esperado: al menos 1 fila con `role='owner'` (el dueño). `name='Rushmira (Colombia)'`, `country_code='CO'`.

- [ ] **Step 5: Verificar que NO quedaron NULLs y la config migró (SQL Editor)**

```sql
SELECT
  (SELECT count(*) FROM public.orders WHERE store_id IS NULL)                 AS orders_null,
  (SELECT count(*) FROM public.dropi_wallet_movements WHERE store_id IS NULL) AS wallet_null,
  (SELECT (dropi_api_key IS NOT NULL) FROM public.store_dropi_config
     WHERE store_id='00000000-0000-0000-0000-000000000001')                  AS tiene_api_key;
```
Esperado: `orders_null=0`, `wallet_null=0`, `tiene_api_key=true`.

---

### Task 4: Registrar en PROGRESS.md y cerrar bloque

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: Anotar SP1a como completado**

Añadir bajo `## Completado`:
```markdown
- **Multi-tienda SP1a (schema + backfill):** tablas `stores`/`store_members`/`store_dropi_config` + helpers RLS; `store_id` poblado en 16 tablas; Tienda Colombia (UUID `…0001`) con dueño + operadores migrados; config Dropi movida de `app_settings`. RLS de tablas existentes SIN cambiar todavía (eso es SP1b). (2026-05-21)
```

- [ ] **Step 2: Commit + push**

```bash
git add PROGRESS.md
git commit -m "docs(multitienda): registrar SP1a aplicado en PROGRESS.md"
git push -u origin feat/multitienda-sp1a
```

---

## Self-Review (resultado)

**1. Spec coverage:**
- "crear tablas stores/store_members/store_dropi_config + helpers RLS" → Task 1 ✅
- "agregar store_id a ~16 tablas" → Task 2 ✅ (16 enumeradas)
- "backfill a Tienda Colombia" → Task 3 ✅ (tienda + miembros + config + UPDATEs)
- "orden y reversibilidad críticos / no CLI local" → sección Contexto operativo + apply-vía-Lovable + verificación SQL ✅
- "reescribir RLS por pertenencia" y "scopear RPCs con p_store_id" → **fuera de SP1a por diseño**; son SP1b (su propio plan). El RLS de las tablas existentes NO se toca acá.
- "StoreContext frontend" → **fuera de SP1a por diseño**; es SP1c.

**2. Placeholder scan:** sin TBD/TODO; todo el SQL está completo y enumerado tabla por tabla (sin "similar al anterior").

**3. Type/identidad consistency:** UUID centinela `00000000-0000-0000-0000-000000000001` idéntico en `DEFAULT`, backfill y verificación. Nombres de helpers (`auth_store_ids`, `is_store_member`, `store_role`, `is_store_owner`) consistentes entre Task 1 y las políticas. Las 16 tablas idénticas en Task 2 (ALTER), Task 2 (índices), Task 3 (UPDATE/DEFAULT/NOT NULL).

**Dependencia hacia adelante (anotada para SP2):** el `DEFAULT` al centinela es temporal. En SP2, cuando las edge functions seteen `store_id` explícito y exista la Tienda Ecuador, hay que **quitar el DEFAULT** (`ALTER COLUMN store_id DROP DEFAULT`) para que ninguna fila caiga por error en Colombia.

---

## Riesgo residual / rollback

- **Rollback de SP1a:** como no se tocó RLS existente, revertir es `DROP TABLE store_dropi_config, store_members, stores CASCADE;` (el CASCADE quita las FK `store_id`) + `ALTER TABLE … DROP COLUMN store_id` si se quiere limpieza total. La app sigue funcionando igual con o sin las columnas porque nada en `src/` las consume todavía.
- **Lo que NO cambia en SP1a:** visibilidad de datos, RPCs, edge functions, frontend. Si algo de la operación se rompe tras aplicar SP1a, NO es por aislamiento (no se activó) — revisar la migración aplicada.
