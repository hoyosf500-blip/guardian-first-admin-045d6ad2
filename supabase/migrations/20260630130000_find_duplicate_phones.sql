-- Guardia anti-duplicados del panel anti-fuga (Confirmar).
--
-- Problema: el push solo deduplica por shopify_order_id. Un duplicado se crea
-- cuando el MISMO cliente entra a Dropi por dos caminos (a mano + "Subir a Dropi")
-- o como dos pedidos de Shopify distintos → 2 órdenes en Dropi, mismo teléfono.
-- Y como la lista de pendientes tarda (cron 5 min), un pedido recién metido
-- reaparece y tienta a re-mandarlo.
--
-- Esta RPC recibe los teléfonos de los pendientes y devuelve, de `orders`, los
-- que YA tienen un pedido en Dropi NO cancelado con ese mismo teléfono
-- normalizado (últimos 9 dígitos — sirve CO y EC). El front bloquea el envío de
-- esos y muestra cuál es el pedido que ya existe.
--
-- Regla: "teléfono repetido SIEMPRE" (sin ventana de fecha). El front deja un
-- escape "No es duplicado" para la recompra legítima.
--
-- Store-scoped por p_store_id explícito + is_store_member (hard-stop si no es
-- miembro) — evita la clase de leak de _resolve_scope_store() con store NULL.

-- Índice funcional para que el match por teléfono normalizado no escanee toda
-- la tabla aunque mire todo el histórico.
CREATE INDEX IF NOT EXISTS orders_store_phone_norm_idx
  ON public.orders (store_id, (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9)));

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
      AND upper(coalesce(o.estado, '')) NOT LIKE '%CANCEL%';  -- ignora cancelados
END $$;

GRANT EXECUTE ON FUNCTION public.find_duplicate_phones(uuid, text[]) TO authenticated;
