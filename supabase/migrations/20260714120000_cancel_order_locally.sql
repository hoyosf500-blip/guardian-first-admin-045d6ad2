-- cancel_order_locally: guarda atómica server-side para la CANCELACIÓN, espejo
-- exacto de confirm_order_locally (20260427120400).
--
-- BUG (auditoría 2026-07-14, #9): la rama 'canc' de markResult no tenía
-- equivalente atómico a confirm_order_locally. El estado local NO se flipeaba
-- hasta que Dropi confirmaba (varios segundos después), y release_order soltaba
-- el lock antes → una ventana donde el pedido reaparecía PENDIENTE CONFIRMACION
-- sin lock en la cola de OTRA asesora → doble-cancel (2 filas + 2 invokes), o
-- peor, confirmar-mientras-el-otro-cancela = estado contradictorio Dropi↔Guardian.
--
-- Fix: flipear el estado a CANCELADO ATÓMICAMENTE con guarda
-- WHERE estado='PENDIENTE CONFIRMACION' — SOLO la primera asesora gana
-- (RETURN FOUND=true); la segunda obtiene FALSE y su UI aborta sin insertar
-- nada. Optimista igual que confirm (que marca PENDIENTE): si Dropi luego
-- rechaza el cancel, el cron reintenta y el panel de fallos lo muestra —
-- misma red de seguridad que la confirmación.

CREATE OR REPLACE FUNCTION public.cancel_order_locally(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operator')) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;

  -- Solo cancela un pedido que SIGUE pendiente de confirmación: si otra asesora
  -- ya lo confirmó (PENDIENTE), canceló (CANCELADO) o Dropi lo movió, FOUND=false
  -- y el cliente sabe que perdió la carrera (no doble-cancela ni pisa un conf).
  UPDATE public.orders
    SET estado = 'CANCELADO'
    WHERE id = p_order_id AND estado = 'PENDIENTE CONFIRMACION';
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_order_locally(UUID) TO authenticated;
