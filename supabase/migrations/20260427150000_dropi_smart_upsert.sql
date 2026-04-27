-- Upsert condicional para dropi-cron: solo escribe filas que cambiaron
-- en algún campo relevante. Antes el cron usaba supabase.upsert() con
-- ON CONFLICT DO UPDATE incondicional → cada fila se "actualizaba"
-- aunque el contenido fuera idéntico → Postgres disparaba realtime
-- UPDATE para todas → frontend recibía 500-2000 eventos cada 5 min
-- aunque solo ~5-30 fueran cambios reales.
--
-- Con esta función el WHERE en ON CONFLICT DO UPDATE filtra: si todos
-- los campos relevantes son IS NOT DISTINCT FROM (mismos valores,
-- contando NULLs como iguales), no se hace UPDATE → no fire trigger
-- → no se broadcast realtime → no re-render en el frontend.
--
-- Campos NO incluidos en el WHERE:
--   - phone, external_id: claves de identidad / conflict
--   - assigned_to, locked_by, locked_at: gestión interna, no de Dropi
--   - created_at, uploaded_by, upload_date: metadata estable
--
-- Resultado esperado: realtime UPDATE events bajan ~95% en cron runs.

CREATE OR REPLACE FUNCTION public.upsert_orders_from_dropi(p_orders jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed integer;
BEGIN
  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset(p_orders) AS x(
      external_id    text,
      uploaded_by    uuid,
      upload_date    date,
      nombre         text,
      phone          text,
      ciudad         text,
      departamento   text,
      producto       text,
      estado         text,
      fecha          text,
      fecha_conf     text,
      dias           integer,
      dias_conf      integer,
      valor          numeric,
      flete          numeric,
      costo_prod     numeric,
      costo_dev      numeric,
      cantidad       integer,
      direccion      text,
      novedad        text,
      guia           text,
      transportadora text,
      tags           text,
      tienda         text,
      novedad_sol    boolean
    )
  ),
  upserted AS (
    INSERT INTO public.orders (
      external_id, uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, estado, fecha, fecha_conf, dias, dias_conf,
      valor, flete, costo_prod, costo_dev, cantidad, direccion, novedad,
      guia, transportadora, tags, tienda, novedad_sol
    )
    SELECT
      external_id, uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, estado, fecha, fecha_conf, dias, dias_conf,
      valor, flete, costo_prod, costo_dev, cantidad, direccion, novedad,
      guia, transportadora, tags, tienda, novedad_sol
    FROM input_rows
    ON CONFLICT (external_id) DO UPDATE SET
      estado          = EXCLUDED.estado,
      guia            = EXCLUDED.guia,
      transportadora  = EXCLUDED.transportadora,
      novedad         = EXCLUDED.novedad,
      novedad_sol     = EXCLUDED.novedad_sol,
      fecha_conf      = EXCLUDED.fecha_conf,
      dias            = EXCLUDED.dias,
      dias_conf       = EXCLUDED.dias_conf,
      valor           = EXCLUDED.valor,
      flete           = EXCLUDED.flete,
      costo_prod      = EXCLUDED.costo_prod,
      costo_dev       = EXCLUDED.costo_dev,
      cantidad        = EXCLUDED.cantidad,
      direccion       = EXCLUDED.direccion,
      ciudad          = EXCLUDED.ciudad,
      departamento    = EXCLUDED.departamento,
      producto        = EXCLUDED.producto,
      nombre          = EXCLUDED.nombre,
      tags            = EXCLUDED.tags,
      tienda          = EXCLUDED.tienda,
      fecha           = EXCLUDED.fecha
    WHERE
      orders.estado          IS DISTINCT FROM EXCLUDED.estado
      OR orders.guia            IS DISTINCT FROM EXCLUDED.guia
      OR orders.transportadora  IS DISTINCT FROM EXCLUDED.transportadora
      OR orders.novedad         IS DISTINCT FROM EXCLUDED.novedad
      OR orders.novedad_sol     IS DISTINCT FROM EXCLUDED.novedad_sol
      OR orders.fecha_conf      IS DISTINCT FROM EXCLUDED.fecha_conf
      OR orders.dias            IS DISTINCT FROM EXCLUDED.dias
      OR orders.dias_conf       IS DISTINCT FROM EXCLUDED.dias_conf
      OR orders.valor           IS DISTINCT FROM EXCLUDED.valor
      OR orders.flete           IS DISTINCT FROM EXCLUDED.flete
      OR orders.costo_prod      IS DISTINCT FROM EXCLUDED.costo_prod
      OR orders.costo_dev       IS DISTINCT FROM EXCLUDED.costo_dev
      OR orders.cantidad        IS DISTINCT FROM EXCLUDED.cantidad
      OR orders.direccion       IS DISTINCT FROM EXCLUDED.direccion
      OR orders.ciudad          IS DISTINCT FROM EXCLUDED.ciudad
      OR orders.departamento    IS DISTINCT FROM EXCLUDED.departamento
      OR orders.producto        IS DISTINCT FROM EXCLUDED.producto
      OR orders.nombre          IS DISTINCT FROM EXCLUDED.nombre
      OR orders.tags            IS DISTINCT FROM EXCLUDED.tags
      OR orders.tienda          IS DISTINCT FROM EXCLUDED.tienda
      OR orders.fecha           IS DISTINCT FROM EXCLUDED.fecha
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM upserted;

  RETURN COALESCE(v_changed, 0);
END;
$$;

-- Solo service_role (cron) y authenticated (admin manual sync) la
-- pueden invocar. anon no debe poder spamear.
REVOKE ALL ON FUNCTION public.upsert_orders_from_dropi(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_orders_from_dropi(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.upsert_orders_from_dropi(jsonb) IS
  'Bulk upsert para dropi-sync/dropi-cron con guardia IS DISTINCT FROM. Filas idénticas no se reescriben → no se dispara realtime. Reduce eventos UPDATE ~95% en cron runs.';
