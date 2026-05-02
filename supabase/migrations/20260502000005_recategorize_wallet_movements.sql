-- Re-categoriza movimientos de wallet que el regex viejo clasificó como
-- 'otro' pero que con la lógica nueva (normalización de acentos + regex
-- laxo) deberían ser 'costo_devolucion'. Sin esto, los movimientos
-- existentes con categoria='otro' siguen sin sumar al financial_summary
-- aunque el sync futuro los categorize bien.
--
-- Idempotente — solo afecta filas con categoria='otro' que matcheen el
-- patrón. Si se vuelve a correr, no cambia nada.

UPDATE public.dropi_wallet_movements
SET categoria = 'costo_devolucion'
WHERE categoria = 'otro'
  AND UPPER(codigo) LIKE '%DEVOLUCI%'
  AND (UPPER(codigo) LIKE '%NO EFECTIVA%' OR UPPER(codigo) LIKE '%NO EFECTIVO%');

-- También re-categorizamos comision_referidos y reembolso_flete por si
-- también quedaron como 'otro' (defensivo, mismo bug).

UPDATE public.dropi_wallet_movements
SET categoria = 'reembolso_flete'
WHERE categoria = 'otro'
  AND UPPER(codigo) LIKE '%DEVOLUCI%'
  AND UPPER(codigo) LIKE '%ORDEN ENTREGADA%';

UPDATE public.dropi_wallet_movements
SET categoria = 'comision_referidos'
WHERE categoria = 'otro'
  AND UPPER(codigo) LIKE '%COMISION DE REFERIDOS%';
