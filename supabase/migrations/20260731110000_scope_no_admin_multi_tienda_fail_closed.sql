-- _resolve_scope_store: cerrar el fallback "tienda de menor UUID" del camino NO-admin.
--
-- El camino de ADMIN ya se arregló el 21-jul (20260721120000): si no hay tienda
-- activa y el usuario pertenece a varias, devuelve un CENTINELA que no coincide
-- con ninguna, para que las pantallas salgan VACÍAS en vez de mezclar países.
-- El camino NO-admin quedó con el fallback viejo:
--
--     SELECT store_id ... WHERE role IN ('owner','supervisor')
--      ORDER BY store_id ASC LIMIT 1;
--
-- ...que devuelve la tienda de UUID MENOR. Colombia es
-- '00000000-0000-0000-0000-000000000001', o sea que CO gana casi siempre.
--
-- Escenario: un supervisor de CO y EC (o cualquiera que sea owner de su propia
-- tienda y supervisor de otra) entra y el set_active_store falla por red o corre
-- después de la primera consulta. Productividad, Jornada, Reportes y Logística le
-- muestran los números de COLOMBIA con el nombre de Ecuador en el encabezado. Se
-- evalúa gente y se decide plata con los datos del otro país, y no hay pantalla
-- vacía que lo delate. Es exactamente lo que la migración de julio declaró
-- inaceptable, solo que en la rama que no se tocó.
--
-- ⚠️ REGLA #1: este cuerpo NO se copió del repo. Se partió del
-- `pg_get_functiondef('public._resolve_scope_store'::regproc)` leído de la base
-- el 31-jul-2026 y se cambió ÚNICAMENTE el fallback final del camino no-admin.
-- El camino de admin queda byte a byte como estaba.
--
-- Efecto para el usuario: un manager de UNA sola tienda no nota nada (sigue el
-- fallback). Uno de VARIAS, en la ventana en que aún no hay tienda activa válida,
-- ve las pantallas vacías en lugar de datos del país equivocado. Fail-closed.

CREATE OR REPLACE FUNCTION public._resolve_scope_store()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_store uuid;
  v_count int;
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    -- 1. Tienda activa sincronizada (el caso normal).
    SELECT active_store_id INTO v_store FROM public.profiles WHERE user_id = auth.uid();
    IF v_store IS NOT NULL THEN
      RETURN v_store;
    END IF;

    -- 2. Sin sincronizar: si es miembro de UNA sola tienda no hay ambiguedad.
    SELECT COUNT(*) INTO v_count FROM public.store_members WHERE user_id = auth.uid();
    IF v_count = 1 THEN
      SELECT store_id INTO v_store FROM public.store_members WHERE user_id = auth.uid();
      RETURN v_store;
    END IF;

    -- 3. Varias tiendas y no sabemos cual: CENTINELA (no coincide con ninguna)
    --    para que las pantallas salgan VACIAS en vez de mezclar paises.
    RETURN '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  -- ── Camino NO-admin ──
  SELECT p.active_store_id INTO v_store
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND p.active_store_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.user_id = auth.uid()
        AND m.store_id = p.active_store_id
        AND m.role IN ('owner','supervisor')
    );
  IF v_store IS NOT NULL THEN
    RETURN v_store;
  END IF;

  -- Sin tienda activa valida. Antes se elegia la de UUID menor (CO ganaba
  -- siempre): mismo criterio que el camino de admin, la ambiguedad se resuelve
  -- vaciando la pantalla, nunca adivinando el pais.
  SELECT COUNT(*) INTO v_count FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor');

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;

  IF v_count > 1 THEN
    RETURN '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  SELECT store_id INTO v_store FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor')
   LIMIT 1;
  RETURN v_store;
END $function$;
