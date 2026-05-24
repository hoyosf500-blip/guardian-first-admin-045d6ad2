-- Logística / Billetera / Finanzas por TIENDA ACTIVA para el admin (CO ≠ EC).
--
-- Mismo problema que los reportes de operadoras: TODAS las RPCs de logística,
-- billetera y finanzas resuelven el alcance con `_resolve_scope_store()`, que
-- para un ADMIN GLOBAL devuelve NULL = sin filtro = todas las tiendas. Fabian
-- es admin, así que en Ecuador veía logística/billetera de Colombia mezclada
-- (y son cuentas Dropi distintas).
--
-- En vez de reescribir las ~11 RPCs (logistics_*, wallet_*, financial_summary,
-- product_profitability) una por una — riesgoso y desaconsejado — se arregla en
-- el ÚNICO chokepoint: el resolver. El admin ahora ve la TIENDA QUE ESTÁ
-- MIRANDO, que el cliente persiste en `profiles.active_store_id`. Así TODAS las
-- RPCs que ya usan el resolver quedan scopeadas sin tocar sus cuerpos.
--
-- Managers no-admin (owner/supervisor) siguen viendo solo su tienda (sin cambio).
-- Si un admin nunca seteó tienda activa, active_store_id = NULL = todas (compat).

-- 1. Dónde guardar la tienda activa del usuario (admin).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS active_store_id uuid;

-- 2. El cliente setea su tienda activa (StoreContext, al cargar/cambiar tienda).
--    SECURITY DEFINER: escribe el propio profile saltando RLS. Valida que el
--    caller sea admin o miembro de esa tienda; si no, no-op silencioso (no debe
--    romper el arranque de la app).
CREATE OR REPLACE FUNCTION public.set_active_store(p_store_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_store_id IS NULL THEN
    RETURN;
  END IF;
  IF public.has_role(auth.uid(), 'admin')
     OR EXISTS (
       SELECT 1 FROM public.store_members m
       WHERE m.user_id = auth.uid() AND m.store_id = p_store_id
     ) THEN
    UPDATE public.profiles
       SET active_store_id = p_store_id
     WHERE user_id = auth.uid();
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_active_store(uuid) TO authenticated;

-- 3. Resolver: el admin ahora se scopea a SU tienda activa (no a todas).
--    Resto del comportamiento idéntico a 20260521233349.
CREATE OR REPLACE FUNCTION public._resolve_scope_store()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_store uuid;
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    -- Tienda que el admin está mirando (la persiste el cliente).
    -- NULL si nunca seteó una → ve todas (compat hacia atrás).
    SELECT active_store_id INTO v_store FROM public.profiles WHERE user_id = auth.uid();
    RETURN v_store;
  END IF;
  SELECT store_id INTO v_store FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor') LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN v_store;
END;
$$;
