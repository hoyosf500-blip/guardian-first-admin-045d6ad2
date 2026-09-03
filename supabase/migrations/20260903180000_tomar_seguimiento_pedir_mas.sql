-- ============================================================================
-- "Pedir más": que la asesora que TERMINÓ pueda cargarse más trabajo sola
-- ============================================================================
--
-- Pedido del dueño (3-sep-2026), textual: *"si una asesora terminó, que se le
-- carguen más pedidos"*.
--
-- ── Por qué hace falta una función nueva y no alcanza con la que hay ────────
-- `repartir_seguimiento` (20260821120000) es **manager-only**: exige
-- `is_store_manager`. Eso significa que el reparto SOLO ocurre mientras el
-- dueño o el supervisor tienen Seguimiento abierto en el navegador — no hay
-- nada corriendo del lado del servidor. Medido en el código: el reparto se
-- dispara una vez al día desde `SeguimientoTab`, y si ese día nadie con rango
-- abre la pantalla, no se reparte nada.
--
-- Consecuencia para la persona que trabaja: termina sus pedidos a media mañana
-- y no tiene forma de recibir más hasta que un jefe se conecte. Esta función es
-- lo único que faltaba para que pueda pedirlos ella.
--
-- ── Las cuatro rejas, y por qué cada una ────────────────────────────────────
--   1. `is_store_member` — miembro de ESTA tienda. No manager: el punto entero
--      es que funcione SIN un jefe conectado.
--   2. `operator_id = auth.uid()` — **solo para sí misma**. No existe ningún
--      parámetro de operador: por esta vía es imposible endosarle trabajo a
--      otra persona, ni por error ni a propósito.
--   3. `ON CONFLICT (order_id, dia) DO NOTHING` — **nunca le roba un pedido a
--      quien ya lo tiene hoy**, exactamente igual que la función hermana. Sin
--      esto, "pedir más" sería una forma de descremar: agarrar los fáciles que
--      ya son de otra.
--   4. `p_limite` con tope duro — nadie se lleva la cola entera de un clic y
--      deja al resto del turno sin nada que hacer.
--
-- ⛔ `origen` se queda en 'manual', que YA es un valor permitido por el CHECK
-- de la tabla. Un auto-servicio se reconoce sin ambigüedad porque
-- `assigned_by = operator_id` (a nadie más se lo puede asignar uno mismo). Se
-- eligió así para NO tener que alterar el CHECK: cero DDL sobre la tabla.
--
-- ⛔ REGLA #0 — esta migración **crea una función y nada más**. No hay ALTER,
-- ni índice nuevo, ni UPDATE masivo, y `seg_asignaciones` no es una de las
-- tablas calientes (`orders`, `order_results`, `touchpoints`). Aun así va con
-- `lock_timeout` por disciplina: si algo inesperado tuviera la tabla tomada,
-- esto falla en 5 s en vez de encolar a todo el mundo detrás.
--
-- ⛔ REGLA #1 — no se reescribe NINGUNA función desplegada.
-- `repartir_seguimiento` y `reasignar_seguimiento` no se tocan.
--
-- ⛔ Y la lección de mayo-2026 sigue en pie (20260524120000): la asignación es
-- una ETIQUETA DE RESPONSABILIDAD, **nunca un candado**. Nada de lo de acá
-- esconde un pedido ni impide que otra persona lo gestione. Si alguien alguna
-- vez agrega ese bloqueo, está repitiendo el error que ya se pagó.
-- ============================================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.tomar_seguimiento(
  p_store_id  uuid,
  p_order_ids uuid[],
  p_limite    int DEFAULT 20
)
RETURNS TABLE (tomados int)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dia    date;
  v_yo     uuid := auth.uid();
  v_limite int;
  v_n      int := 0;
BEGIN
  IF v_yo IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;

  -- Miembro de esta tienda. A propósito NO se exige manager.
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado para tomar pedidos de esta tienda'
      USING ERRCODE = '42501';
  END IF;

  -- Tope duro: aunque la pantalla mande mil ids, de acá no salen más de 50.
  v_limite := LEAST(GREATEST(COALESCE(p_limite, 20), 1), 50);

  v_dia := (now() AT TIME ZONE 'America/Bogota')::date;

  WITH pedidos AS (
    SELECT DISTINCT o.id AS order_id
    FROM unnest(COALESCE(p_order_ids, ARRAY[]::uuid[])) AS x(id)
    -- Solo pedidos de ESTA tienda. Un id de otra empresa se ignora en silencio
    -- (no aborta el lote): lo que no pasa el filtro, simplemente no se toma.
    JOIN public.orders o ON o.id = x.id AND o.store_id = p_store_id
    -- Y solo los que HOY no tienen dueño. El ON CONFLICT de abajo ya lo
    -- garantiza; este filtro está para que el LIMIT no se gaste contando
    -- pedidos ajenos y devuelva menos de los que sí se podían tomar.
    WHERE NOT EXISTS (
      SELECT 1 FROM public.seg_asignaciones sa
      WHERE sa.order_id = o.id AND sa.dia = v_dia
    )
    LIMIT v_limite
  )
  INSERT INTO public.seg_asignaciones (store_id, order_id, operator_id, dia, origen, assigned_by)
  SELECT p_store_id, p.order_id, v_yo, v_dia, 'manual', v_yo
  FROM pedidos p
  -- Nunca le roba un pedido a quien ya lo tiene hoy.
  ON CONFLICT (order_id, dia) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN QUERY SELECT v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.tomar_seguimiento(uuid, uuid[], int) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.tomar_seguimiento(uuid, uuid[], int) TO authenticated;

COMMENT ON FUNCTION public.tomar_seguimiento(uuid, uuid[], int) IS
  'La asesora que terminó se carga más pedidos SOLA, sin depender de que un '
  'jefe esté conectado. Miembro (no manager), SIEMPRE para sí misma '
  '(operator_id = auth.uid(), no hay parámetro de operador), tope duro de 50, y '
  'ON CONFLICT DO NOTHING: nunca le quita un pedido a quien ya lo tiene hoy. '
  'La asignación sigue siendo una etiqueta de responsabilidad, NO un candado '
  '(ver 20260524120000).';
