-- Cancelaciones: el UNIVERSO del período en una sola consulta barata.
--
-- POR QUÉ EXISTE
-- --------------
-- `cancelaciones_analisis` devuelve `total_periodo` y `generados_periodo`
-- repetidos en CADA FILA. Eso funcionaba cuando se llamaba UNA vez por el rango
-- entero. Desde que el cliente consulta POR TRAMOS de 5 días (la función se cae
-- por timeout en el rango por defecto: hace subconsultas LATERAL por pedido),
-- esos dos totales hay que sumarlos tramo por tramo, y ahí aparecieron dos
-- fallas MEDIDAS, las dos en la misma dirección — la tasa de cancelación que se
-- muestra en pantalla queda mal:
--
--   1. Un tramo SIN cancelaciones no devuelve NINGUNA fila, y con ellas se va su
--      `generados_periodo`. El denominador queda corto → la tasa sale inflada.
--      El cliente lo tapaba marcando el denominador como incompleto y mostrando
--      "—", o sea: CUALQUIER racha de 5 días sin cancelar borraba la tasa del
--      período entero. En una tienda chica eso es casi siempre.
--
--   2. Un tramo que se cae (timeout que ni partido a la mitad entra) se anotaba
--      en la lista de "días sin leer" pero NO marcaba el denominador. La tasa se
--      seguía imprimiendo con numerador Y denominador cortos, sin decir que el
--      número no correspondía al rango pedido. Silencioso, que es lo peor.
--
-- La respuesta NO es que el cliente cuente por su cuenta: la definición del
-- universo (qué es "generado", qué es "borrado") tiene que vivir en UN solo
-- lugar. Si la tasa se armara cruzando esta función con un COUNT hecho en el
-- navegador, cualquier diferencia de filtro daría un porcentaje que nadie puede
-- auditar. Es el mismo argumento que ya está escrito en `cancelaciones_analisis`
-- para justificar que el denominador se calcule ahí adentro.
--
-- Entonces: esta función repite EXACTAMENTE los dos CTE baratos de
-- `cancelaciones_analisis` (`canc` y `gen`) y NADA MÁS. Sin los LEFT JOIN
-- LATERAL, que son los que la hacen lenta. Son dos COUNT(*) agregados sobre
-- `orders`: se puede pedir el rango COMPLETO de una, sin trocear, y el
-- resultado no depende de que ningún tramo haya salido bien.
--
-- ⛔ REGLA #1 — ES ADITIVA. No toca `cancelaciones_analisis` ni ninguna otra
-- función viva. Si el cliente no la encuentra (migración sin aplicar) sigue
-- sumando por tramos como hasta ahora: información de más, nunca un bloqueo.
--
-- Los filtros son copia literal de `20260815120000_cancelaciones_analisis.sql`
-- (guard de formato de `fecha`, que es TEXT y no siempre confiable; cohorte por
-- fecha de CREACIÓN; `_estado_bucket` para no depender de cómo se escribió el
-- estado). Si algún día cambian allá, cambian acá — y por eso las dos
-- definiciones están pegadas y comentadas, para que se vea el par.

CREATE OR REPLACE FUNCTION public.cancelaciones_universo(
  p_store_id uuid,
  p_desde    date,
  p_hasta    date
)
RETURNS TABLE (
  generados  bigint,
  cancelados bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Mismo chokepoint que `cancelaciones_analisis`: encargados de ESA tienda.
  -- Fail-closed y con el mismo ERRCODE, para que el cliente lo trate igual.
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta tienda' USING ERRCODE = '42501';
  END IF;

  IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    -- EL DENOMINADOR. Pedidos CREADOS en el período, cancelados INCLUIDOS,
    -- `borrado` (REEMPLAZADA / ARCHIVADO GHOST) EXCLUIDO. Coincide con
    -- financial_summary.tasa_cancelacion_pct y DIFIERE a propósito de
    -- logistics_summary, que saca los cancelados de su total.
    COUNT(*) FILTER (
      WHERE public._estado_bucket(o.estado) <> 'borrado'
    )::bigint AS generados,
    -- EL NUMERADOR. Misma población que el `canc` de `cancelaciones_analisis`:
    -- tiene que cuadrar AL PEDIDO con las filas que esa función devuelve.
    COUNT(*) FILTER (
      WHERE public._estado_bucket(o.estado) = 'cancelado'
    )::bigint AS cancelados
  FROM public.orders o
  WHERE o.store_id = p_store_id
    AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date >= p_desde
    AND o.fecha::date <= p_hasta;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancelaciones_universo(uuid, date, date) FROM public;
REVOKE ALL ON FUNCTION public.cancelaciones_universo(uuid, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancelaciones_universo(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.cancelaciones_universo(uuid, date, date) IS
  'Universo de cancelaciones del período en dos COUNT agregados: generados (denominador) '
  'y cancelados (numerador), con los MISMOS filtros que cancelaciones_analisis. '
  'Existe para que la tasa NO dependa de que el troceo por tramos haya salido completo: '
  'un tramo vacío o caído dejaba el denominador corto y la tasa inflada. Aditiva.';
