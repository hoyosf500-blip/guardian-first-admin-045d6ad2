-- ============================================================================
-- La protección de la novedad resuelta NO cruza tiendas
-- ============================================================================
--
-- Auditoría del 4-sep-2026 sobre `protect_resolved_novedades_bogota`. El
-- EXISTS que arma la protección cruzaba `touchpoints` SOLO por teléfono:
--
--   WHERE phone = OLD.phone AND action LIKE 'NOVEDAD:%' AND action_date >= …
--
-- sin `store_id`. `touchpoints` SÍ tiene `store_id`. Con el mismo número en
-- dos tiendas (un cliente que compra en Rushmira CO y en Colombia 2, o un
-- número repetido entre empresas), una novedad resuelta en la tienda A
-- re-armaba la protección de ese teléfono en la tienda B durante 7 días: el
-- sync que intentaba reponer `novedad_sol=false` en el pedido de B quedaba
-- revertido, y esa novedad —real, de otra empresa— no volvía nunca a la cola.
--
-- Mezclar empresas está PROHIBIDO en esta operación (REGLA #1). El agujero
-- existía antes de ayer; lo que se abrió a 7 días fue la ventana.
--
-- ⛔ REGLA #1 — el cuerpo es el de 20260903230000 (aplicada y verificada con
-- `pg_get_functiondef`), y cambia UNA línea: `AND store_id = OLD.store_id`.
-- ⛔ REGLA #0 — reemplaza una función y nada más. Cero DDL sobre `orders`.
-- ============================================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.protect_resolved_novedades_bogota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- ⛔ EL PEDIDO AVANZÓ: no se toca nada. Esta protección es SOLO contra el sync
  -- que arrastra el pedido de vuelta a la cola de novedades. Un ENTREGADO, un
  -- DEVUELTO o un CANCELADO son la verdad de Dropi, y taparlos rompía la tasa
  -- de entrega y escondía devoluciones.
  IF NEW.estado IS NOT NULL AND NEW.estado !~* 'NOVEDAD' THEN
    RETURN NEW;
  END IF;

  IF (OLD.novedad_sol IS TRUE AND NEW.novedad_sol IS DISTINCT FROM TRUE)
     OR (OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA') THEN
    IF EXISTS (
      SELECT 1 FROM public.touchpoints
      WHERE phone = OLD.phone
        -- ⛔ DE LA MISMA TIENDA. Sin esto, la novedad resuelta de una empresa
        -- protegía (y escondía) la novedad real de otra con el mismo teléfono.
        AND store_id = OLD.store_id
        AND action LIKE 'NOVEDAD:%'
        AND action_date >= (NOW() AT TIME ZONE 'America/Bogota')::date - INTERVAL '7 days'
    ) THEN
      IF NEW.novedad IS NULL
         OR btrim(NEW.novedad) = ''
         OR NEW.novedad IS NOT DISTINCT FROM OLD.novedad THEN
        NEW.novedad_sol := OLD.novedad_sol;
        NEW.estado := OLD.estado;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

COMMENT ON FUNCTION public.protect_resolved_novedades_bogota() IS
  'Protege la novedad resuelta contra el sync durante 7 días, solo mientras el '
  'pedido siga en un estado de novedad, y SOLO con gestiones de la MISMA tienda '
  '(el cruce por teléfono sin store_id mezclaba empresas). '
  'Ver 20260904120000, 20260903230000 y 20260903200000.';
