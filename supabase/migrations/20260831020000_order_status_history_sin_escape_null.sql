-- ============================================================================
-- order_status_history: sacar el escape `store_id IS NULL OR` de la policy
-- ============================================================================
--
-- QUÉ PASA HOY
-- La policy de lectura es:
--     USING (store_id IS NULL OR public.is_store_member(store_id))
-- Ese `store_id IS NULL OR` significa: **cualquier fila sin tienda la ve TODO
-- usuario autenticado**, sea de la empresa que sea. Es el mismo patrón que ya
-- documentamos como fuga multi-inquilino, y es lo que marcó el escaneo de
-- seguridad de Lovable el 30-ago-2026.
--
-- POR QUÉ NO ES UN INCENDIO (medido, no supuesto)
-- El 30-ago-2026, desde la app en producción con sesión de dueño:
--   · 41.010 filas en la tabla
--   · **0 filas con `store_id` NULL**  → hoy no se filtra NADA
--   · sin sesión (clave anon) devuelve 42501 permission denied
-- O sea: es una mina enterrada, no una fuga activa. Se desarma antes de que
-- alguien la pise.
--
-- POR QUÉ EL `OR` NO SERVÍA PARA NADA
-- `public.is_store_member(p_store_id)` ya empieza con `p_store_id IS NOT NULL
-- AND EXISTS (...)` (migración 20260730140000). Es decir: para un NULL devuelve
-- false por su cuenta. El `store_id IS NULL OR` no habilitaba ningún caso
-- legítimo — solo abría el agujero. Sacarlo no le quita acceso a nadie.
--
-- ⛔ REGLA #0 — `order_status_history` la escribe un TRIGGER sobre `orders`, en
-- cada cambio de estado, con el cron corriendo cada 10 min. DROP/CREATE POLICY
-- toma ACCESS EXCLUSIVE sobre la tabla: con `lock_timeout` esto FALLA RÁPIDO en
-- vez de encolar a todo el mundo detrás de un lock que no consigue. Si aborta
-- por timeout, NO reintentar en bucle: correrla en un momento más tranquilo.
--
-- ⛔ REGLA #1 — acá NO se está copiando el cuerpo de ninguna función desde el
-- repo. Se reemplaza UNA policy, por su nombre exacto, y el predicado nuevo es
-- estrictamente más angosto que cualquier versión plausible de la anterior
-- (le saca exactamente el caso NULL, que hoy son 0 filas). `is_store_member` no
-- se toca.
-- ============================================================================

SET lock_timeout = '5s';

-- Deja dicho en el log cuántas filas quedarían ocultas. Con 0 (lo medido) el
-- cambio es puramente preventivo. Si algún día NO es 0, esto lo grita en vez de
-- esconderlo: una fila sin tienda es un bug de escritura, no algo para tapar.
DO $$
DECLARE n_null bigint;
BEGIN
  SELECT count(*) INTO n_null FROM public.order_status_history WHERE store_id IS NULL;
  IF n_null > 0 THEN
    RAISE WARNING 'order_status_history: % filas con store_id NULL quedan ocultas — revisar QUIÉN las escribió sin tienda', n_null;
  ELSE
    RAISE NOTICE 'order_status_history: 0 filas con store_id NULL; el cambio no le quita acceso a nadie';
  END IF;
END $$;

DROP POLICY IF EXISTS "members read order status history" ON public.order_status_history;

CREATE POLICY "members read order status history" ON public.order_status_history
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- Sin policy de INSERT/UPDATE/DELETE a propósito: la tabla la llena el trigger
-- SECURITY DEFINER. Los usuarios no escriben acá.
