-- Fix multi-tienda: la auto-asignación de pedidos a operadoras NO estaba
-- scopeada por tienda. El trigger `assign_order_to_operator` (migration
-- 20260417194021) repartía CADA pedido nuevo entre el `operator_pool` GLOBAL
-- (poblado de `user_roles WHERE role='operator'`), sin mirar `store_id`.
--
-- Consecuencia (auditada 2026-05-23): ~1466 pedidos de Ecuador quedaron
-- asignados a operadoras de Colombia (Silvana, Mayra), y la operadora real de
-- Ecuador (María José) con 0 pedidos. La etiqueta "gestionado por X" mentía.
--
-- Fix: el trigger ahora elige la operadora ENTRE LOS MIEMBROS DE LA TIENDA del
-- pedido (`store_members WHERE store_id = NEW.store_id AND role = 'operator'`).
-- Si la tienda no tiene operadoras, el pedido queda SIN asignar (correcto).
-- Determinístico por hash del external_id (igual que antes), pero por-tienda.
--
-- NOTA: el backfill de los pedidos EC ya mal-asignados se hizo a mano
-- (reasignados a la operadora EC). `operator_pool` queda vestigial — ya no lo
-- usa el trigger; se deja por compatibilidad con otras lecturas.

CREATE OR REPLACE FUNCTION public.assign_order_to_operator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
  v_slot  INT;
  v_user  UUID;
BEGIN
  -- Ya asignado → respetar
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Sin tienda → no se puede scopear, dejar sin asignar
  IF NEW.store_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Operadoras (role='operator') que son MIEMBROS de la tienda del pedido
  SELECT COUNT(*) INTO v_count
  FROM public.store_members
  WHERE store_id = NEW.store_id
    AND role = 'operator';

  -- Tienda sin operadoras propias → dejar sin asignar (NO repartir a otra tienda)
  IF v_count = 0 THEN
    RETURN NEW;
  END IF;

  -- Slot determinístico por external_id (fallback id), igual criterio que antes
  v_slot := abs(hashtext(COALESCE(NEW.external_id, NEW.id::text))) % v_count;

  SELECT user_id INTO v_user
  FROM (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY user_id) - 1 AS pos
    FROM public.store_members
    WHERE store_id = NEW.store_id
      AND role = 'operator'
  ) ranked
  WHERE pos = v_slot;

  NEW.assigned_to := v_user;
  RETURN NEW;
END;
$$;

-- El trigger trg_assign_order_to_operator (BEFORE INSERT ON orders) ya existe y
-- apunta a esta función; con CREATE OR REPLACE no hace falta recrearlo.
