-- novedades_root_cause — causa raíz de devoluciones (Módulo 2, inteligencia /novedades).
--
-- Devuelve UNA fila por devolución del período, enriquecida con: el semáforo
-- (validation_decision) + tipo de dirección (address_kind) que tenía al despachar,
-- el valor, y la OPERADORA QUE CONFIRMÓ (último order_results module='confirmar'
-- result='conf' por order_id — join EXACTO, no por teléfono). El cliente
-- (summarizeRootCause en src/lib/novedadRootCause.ts) calcula "% evitable", $
-- perdido y el ranking de operadoras.
--
-- Por qué backend: el join a order_results (DISTINCT por order_id, vía LATERAL)
-- sobre toda la tabla orders es caro/incómodo client-side, y RLS. Store-scoped
-- con _resolve_scope_store() (mismo chokepoint que logistics_summary / wallet_*):
-- admin → su tienda activa; owner/supervisor → su tienda; OPERADOR → 42501 (la
-- vista lleva nombres de operadoras + plata, es de encargado). Mismo filtro de
-- fecha (o.fecha::date, columna TEXT) que las otras RPCs de logística para que
-- los números reconcilien entre vistas.
--
-- "Devuelto" = mismo criterio que classifyDeliveryOutcome del cliente
-- (DEVUELT / DEVOLUC / RECHAZ). Cap defensivo de 5000 filas (mayor valor primero);
-- el cliente avisa si llegó al tope.

CREATE OR REPLACE FUNCTION public.novedades_root_cause(
  p_from date,
  p_to   date
)
RETURNS TABLE (
  order_id            uuid,
  novedad             text,
  validation_decision text,
  address_kind        text,
  valor               numeric,
  transportadora      text,
  ciudad              text,
  confirmer_id        uuid,
  confirmer_name      text,
  tiene_novedad       boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  RETURN QUERY
  SELECT
    o.id,
    o.novedad,
    o.validation_decision,
    o.address_kind,
    o.valor,
    o.transportadora,
    o.ciudad,
    conf.operator_id,
    p.display_name,
    (o.novedad IS NOT NULL AND btrim(o.novedad) <> '')
  FROM public.orders o
  LEFT JOIN LATERAL (
    SELECT r.operator_id
    FROM public.order_results r
    WHERE r.order_id = o.id
      AND r.module = 'confirmar'
      AND r.result = 'conf'
      AND (v_store IS NULL OR r.store_id = v_store)
    ORDER BY r.created_at DESC
    LIMIT 1
  ) conf ON true
  LEFT JOIN public.profiles p ON p.user_id = conf.operator_id
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from AND p_to
    AND (v_store IS NULL OR o.store_id = v_store)
    AND (
      o.estado ILIKE '%DEVUELT%'
      OR o.estado ILIKE '%DEVOLUC%'
      OR o.estado ILIKE '%RECHAZ%'
    )
  ORDER BY o.valor DESC NULLS LAST
  LIMIT 5000;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.novedades_root_cause(date, date) TO authenticated;
