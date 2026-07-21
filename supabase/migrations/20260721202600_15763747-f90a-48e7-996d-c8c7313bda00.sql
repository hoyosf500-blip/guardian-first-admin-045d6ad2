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
      external_id       text,
      uploaded_by       uuid,
      upload_date       date,
      nombre            text,
      phone             text,
      ciudad            text,
      departamento      text,
      producto          text,
      productos_detalle jsonb,
      estado            text,
      fecha             text,
      fecha_conf        text,
      dias              integer,
      dias_conf         integer,
      valor             numeric,
      flete             numeric,
      costo_prod        numeric,
      costo_dev         numeric,
      cantidad          integer,
      direccion         text,
      novedad           text,
      guia              text,
      transportadora    text,
      tags              text,
      tienda            text,
      novedad_sol       boolean,
      last_movement_at  timestamptz
    )
  ),
  upserted AS (
    INSERT INTO public.orders (
      external_id, uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, productos_detalle, estado, fecha, fecha_conf,
      dias, dias_conf, valor, flete, costo_prod, costo_dev, cantidad,
      direccion, novedad, guia, transportadora, tags, tienda, novedad_sol,
      last_movement_at
    )
    SELECT
      external_id, uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, productos_detalle, estado, fecha, fecha_conf,
      dias, dias_conf, valor, flete, costo_prod, costo_dev, cantidad,
      direccion, novedad, guia, transportadora, tags, tienda, novedad_sol,
      last_movement_at
    FROM input_rows
    ON CONFLICT (external_id) DO UPDATE SET
      estado           = EXCLUDED.estado,
      guia             = EXCLUDED.guia,
      transportadora   = EXCLUDED.transportadora,
      novedad          = EXCLUDED.novedad,
      novedad_sol      = EXCLUDED.novedad_sol,
      fecha_conf       = EXCLUDED.fecha_conf,
      dias             = EXCLUDED.dias,
      dias_conf        = EXCLUDED.dias_conf,
      valor            = EXCLUDED.valor,
      flete            = EXCLUDED.flete,
      costo_prod       = EXCLUDED.costo_prod,
      costo_dev        = EXCLUDED.costo_dev,
      cantidad         = EXCLUDED.cantidad,
      direccion        = EXCLUDED.direccion,
      ciudad           = EXCLUDED.ciudad,
      departamento     = EXCLUDED.departamento,
      producto         = EXCLUDED.producto,
      productos_detalle = COALESCE(EXCLUDED.productos_detalle, orders.productos_detalle),
      nombre           = EXCLUDED.nombre,
      tags             = EXCLUDED.tags,
      tienda           = EXCLUDED.tienda,
      fecha            = EXCLUDED.fecha,
      last_movement_at = EXCLUDED.last_movement_at
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
      OR (EXCLUDED.productos_detalle IS NOT NULL
          AND orders.productos_detalle IS DISTINCT FROM EXCLUDED.productos_detalle)
      OR orders.nombre          IS DISTINCT FROM EXCLUDED.nombre
      OR orders.tags            IS DISTINCT FROM EXCLUDED.tags
      OR orders.tienda          IS DISTINCT FROM EXCLUDED.tienda
      OR orders.fecha           IS DISTINCT FROM EXCLUDED.fecha
      OR orders.last_movement_at IS DISTINCT FROM EXCLUDED.last_movement_at
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM upserted;

  RETURN COALESCE(v_changed, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_orders_from_dropi(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_orders_from_dropi(jsonb) TO authenticated, service_role;