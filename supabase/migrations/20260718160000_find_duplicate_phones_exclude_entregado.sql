-- Guardia anti-duplicados: ENTREGADO ya no cuenta como duplicado (= recompra).
--
-- Regla del dueño 2026-07-18: si un pedido del cliente YA está ENTREGADO y el
-- cliente vuelve a comprar, NO es un duplicado — es una RECOMPRA (venta nueva) y
-- debe poder subirse a Dropi. Solo un pedido EN CURSO (cualquier estatus que no
-- sea entregado ni cancelado) cuenta como duplicado (para no crear dos veces el
-- mismo pedido activo).
--
-- Antes `find_duplicate_phones` marcaba como duplicado cualquier pedido no
-- cancelado con el mismo teléfono — incluyendo los ENTREGADOS → las recompras
-- salían con etiqueta "duplicado" en el panel anti-fuga y el botón "Subir todos"
-- las saltaba. Se agrega la exclusión de ENTREGADO. Esta RPC la usan el panel
-- anti-fuga y el guard del push MANUAL (shopify-push-dropi con JWT de usuario);
-- el robot (shopify-auto-push, camino cron) aplica la MISMA regla por su lado.

CREATE OR REPLACE FUNCTION public.find_duplicate_phones(p_store_id uuid, p_phones text[])
RETURNS TABLE (
  phone_norm  text,
  external_id text,
  estado      text,
  fecha       text,
  nombre      text,
  created_at  timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_store_id IS NULL OR NOT public.is_store_member(p_store_id) THEN
    RETURN;  -- hard-stop: sin tienda válida no devuelve nada (no leak global)
  END IF;

  RETURN QUERY
    SELECT right(regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g'), 9) AS phone_norm,
           o.external_id::text,
           o.estado,
           o.fecha::text,
           o.nombre,
           o.created_at
    FROM public.orders o
    WHERE o.store_id = p_store_id
      AND right(regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g'), 9) = ANY(p_phones)
      AND right(regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g'), 9) <> ''
      AND upper(coalesce(o.estado, '')) NOT LIKE '%CANCEL%'      -- cancelado → muerto, no duplicado
      AND upper(coalesce(o.estado, '')) NOT LIKE '%ENTREGAD%';   -- entregado → recompra, no duplicado
END $$;

GRANT EXECUTE ON FUNCTION public.find_duplicate_phones(uuid, text[]) TO authenticated;
