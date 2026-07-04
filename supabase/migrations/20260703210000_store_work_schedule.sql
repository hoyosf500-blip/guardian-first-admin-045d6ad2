-- Horario laboral CONFIGURABLE por tienda (decisión del dueño 2026-07-03).
--
-- PROBLEMA: las advertencias de inactividad (useInactivityGuard + inactivityWindow)
-- asumían un horario FIJO 9:00–17:00 Bogotá. Pero hay operadoras que trabajan de
-- noche (ej. última acción 8:18 p. m.), así que el "tiempo laboral perdido" se
-- medía contra un horario que NO cumplen → número inflado y desconectado del resto.
--
-- Ahora cada tienda define su horario. Guardado como minutos-del-día (0–1439) para
-- que el cálculo (segundos-del-día, ver inactivityWindow.ts) sea exacto. CO y EC
-- comparten wall-clock (UTC-5 sin DST), una sola TZ. Defaults = el 9–17 histórico.

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS work_start_min  smallint NOT NULL DEFAULT 540,   -- 09:00
  ADD COLUMN IF NOT EXISTS work_end_min    smallint NOT NULL DEFAULT 1020,  -- 17:00
  ADD COLUMN IF NOT EXISTS lunch_start_min smallint NOT NULL DEFAULT 750,   -- 12:30
  ADD COLUMN IF NOT EXISTS lunch_end_min   smallint NOT NULL DEFAULT 810;   -- 13:30

-- RPC de update: solo manager (owner/supervisor) de ESA tienda, o admin global.
-- SECURITY DEFINER (bypassa RLS de stores) pero valida membresía server-side.
CREATE OR REPLACE FUNCTION public.update_store_schedule(
  p_store_id        uuid,
  p_work_start_min  int,
  p_work_end_min    int,
  p_lunch_start_min int,
  p_lunch_end_min   int
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  -- Autorización: admin global O manager (owner/supervisor) de la tienda.
  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.store_members
      WHERE store_id = p_store_id
        AND user_id = auth.uid()
        AND role IN ('owner','supervisor')
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;

  -- Validación de rangos: 0..1440, inicio < fin del horario; almuerzo coherente
  -- (start <= end) y contenido en el día. Un almuerzo "vacío" (start = end) es
  -- válido = sin almuerzo excluido.
  IF p_work_start_min < 0 OR p_work_end_min > 1440 OR p_work_start_min >= p_work_end_min THEN
    RAISE EXCEPTION 'Horario laboral inválido (inicio < fin, 0..1440)';
  END IF;
  IF p_lunch_start_min < 0 OR p_lunch_end_min > 1440 OR p_lunch_start_min > p_lunch_end_min THEN
    RAISE EXCEPTION 'Almuerzo inválido (inicio <= fin, 0..1440)';
  END IF;

  UPDATE public.stores
  SET work_start_min  = p_work_start_min,
      work_end_min    = p_work_end_min,
      lunch_start_min = p_lunch_start_min,
      lunch_end_min   = p_lunch_end_min
  WHERE id = p_store_id;
END $$;

GRANT EXECUTE ON FUNCTION public.update_store_schedule(uuid, int, int, int, int) TO authenticated;
