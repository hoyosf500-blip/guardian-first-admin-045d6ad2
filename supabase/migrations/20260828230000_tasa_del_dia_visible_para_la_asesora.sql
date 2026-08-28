-- El banner de tasa del día de la ASESORA nunca se dibujó. Medido en producción
-- el 28-ago-2026 con una cuenta rol `operator` de Ecuador, con su tienda activa
-- correctamente sincronizada:
--
--     POST /rest/v1/rpc/operator_today_tasa  →  403  {"code":"42501","message":"No autorizado"}
--
-- ════ CAUSA ════
--
-- `operator_today_tasa` resolvía la tienda con `_resolve_scope_store()`. Ese
-- resolvedor es el PERMISO de las pantallas de dueño (Logística, billetera,
-- reportes admin): su camino no-admin cuenta cuántas tiendas ADMINISTRA el que
-- llama (`role IN ('owner','supervisor')`) y, si son cero, lanza 42501.
--
-- Una operadora administra cero tiendas por definición. O sea que la RPC que
-- existe para mostrarle SU propio número la rechazaba siempre, sin importar su
-- configuración.
--
-- ════ POR QUÉ NO SE ARREGLA EN `_resolve_scope_store()` ════
--
-- Ese 42501 al operador NO es un bug allá: es la autorización funcionando. Unas
-- 20 RPCs de dueño dependen de él (logistics_*, wallet_*, admin_daily_reports_range,
-- operator_productivity_stats…). Aflojarlo le abriría Logística y la billetera a
-- las asesoras. El arreglo va acá, donde no hay nada que proteger con él: la
-- consulta ya está encerrada en las filas del propio llamador
-- (`r.operator_id = v_uid`), así que ninguna persona puede ver la de otra.
--
-- ════ QUÉ CAMBIA, EXACTAMENTE ════
--
-- El cuerpo salió de `pg_get_functiondef` de la función DESPLEGADA (REGLA #1 —
-- copiar el del repo habría revertido arreglos vivos). El ÚNICO cambio es cómo
-- se calcula `v_store`:
--
--   · admin  → sigue delegando en `_resolve_scope_store()`. Para el dueño NO
--              cambia absolutamente nada.
--   · el resto → su tienda activa si es miembro (CUALQUIER rol), y si no, la
--                única de la que es miembro.
--   · miembro de cero tiendas → sigue siendo 42501. Fail-closed, igual que antes.
--
-- Se verifica EN LA APP con una cuenta de operadora, no en este editor: acá no
-- hay `auth.uid()` y daría 42501 aunque el arreglo esté bien.

CREATE OR REPLACE FUNCTION public.operator_today_tasa()
 RETURNS TABLE(confirmados bigint, cancelados bigint, noresp bigint, total bigint, tasa_confirmacion numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_store uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- ── ÚNICO CAMBIO respecto a la versión desplegada ──
  IF public.has_role(v_uid, 'admin') THEN
    v_store := public._resolve_scope_store();
  ELSE
    SELECT p.active_store_id INTO v_store
      FROM public.profiles p
     WHERE p.user_id = v_uid
       AND p.active_store_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.store_members m
          WHERE m.user_id = v_uid AND m.store_id = p.active_store_id
       );

    IF v_store IS NULL THEN
      SELECT m.store_id INTO v_store
        FROM public.store_members m
       WHERE m.user_id = v_uid
       ORDER BY m.store_id
       LIMIT 1;
    END IF;

    -- Ni miembro de una sola tienda: no hay nada suyo que mostrar.
    IF v_store IS NULL THEN
      RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'conf')   AS confirmados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'canc')   AS cancelados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'noresp') AS noresp,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result IN ('conf','canc','noresp')) AS gestionados
    FROM public.order_results r
    WHERE r.operator_id = v_uid
      AND r.module = 'confirmar'
      AND r.result_date = v_today
      AND (v_store IS NULL OR r.store_id = v_store)
  )
  SELECT
    b.confirmados,
    b.cancelados,
    b.noresp,
    b.gestionados AS total,
    CASE WHEN (b.confirmados + b.cancelados) = 0 THEN 0
         ELSE ROUND((b.confirmados::numeric / (b.confirmados + b.cancelados)::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM base b;
END;
$function$;
