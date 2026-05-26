-- Fix 1: upsert_orders_from_dropi v5 — re-agrega store_id (mi v4 lo había
-- omitido, así que INSERTs nuevos caían al default CO incluso para EC).

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
      external_id      text,
      store_id         uuid,
      uploaded_by      uuid,
      upload_date      date,
      nombre           text,
      phone            text,
      ciudad           text,
      departamento     text,
      producto         text,
      estado           text,
      fecha            text,
      fecha_conf       text,
      dias             integer,
      dias_conf        integer,
      valor            numeric,
      flete            numeric,
      costo_prod       numeric,
      costo_dev        numeric,
      cantidad         integer,
      direccion        text,
      novedad          text,
      guia             text,
      transportadora   text,
      tags             text,
      tienda           text,
      novedad_sol      boolean,
      last_movement_at timestamptz
    )
  ),
  upserted AS (
    INSERT INTO public.orders (
      external_id, store_id, uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, estado, fecha, fecha_conf, dias, dias_conf,
      valor, flete, costo_prod, costo_dev, cantidad, direccion, novedad,
      guia, transportadora, tags, tienda, novedad_sol, last_movement_at
    )
    SELECT
      external_id,
      COALESCE(store_id, '00000000-0000-0000-0000-000000000001'),
      uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, estado, fecha, fecha_conf, dias, dias_conf,
      valor, flete, costo_prod, costo_dev, cantidad, direccion, novedad,
      guia, transportadora, tags, tienda, novedad_sol, last_movement_at
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
      nombre           = EXCLUDED.nombre,
      tags             = EXCLUDED.tags,
      tienda           = EXCLUDED.tienda,
      fecha            = EXCLUDED.fecha,
      last_movement_at = EXCLUDED.last_movement_at
      -- store_id NO se actualiza: la tienda de un pedido es inmutable.
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
      OR orders.last_movement_at IS DISTINCT FROM EXCLUDED.last_movement_at
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM upserted;

  RETURN COALESCE(v_changed, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_orders_from_dropi(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_orders_from_dropi(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.upsert_orders_from_dropi(jsonb) IS
  'v5: store_id en recordset + COALESCE(default CO) + last_movement_at + IS DISTINCT FROM. store_id es inmutable en UPDATEs.';

-- Fix 2: protect_resolved_novedades_today — quitar ::text spurio
-- (touchpoints.action_date es DATE, no text → "operator does not exist: date = text").
CREATE OR REPLACE FUNCTION public.protect_resolved_novedades_today()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.novedad_sol IS TRUE AND NEW.novedad_sol IS DISTINCT FROM TRUE)
     OR (OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA') THEN
    IF EXISTS (
      SELECT 1 FROM public.touchpoints
      WHERE phone = OLD.phone
        AND action LIKE 'NOVEDAD:%'
        AND action_date = CURRENT_DATE
    ) THEN
      NEW.novedad_sol := OLD.novedad_sol;
      NEW.estado := OLD.estado;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Fix 3: protect_order_financial_fields — el bypass por
-- current_setting('request.jwt.claim.role') fallaba al invocarse RPC con
-- service_role key vía supabase-js (claim no siempre seteado). Usar
-- auth.jwt() y session_user como respaldo.
CREATE OR REPLACE FUNCTION public.protect_order_financial_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role text;
BEGIN
  -- Bypass para service_role (cron / edge functions sincronizando desde Dropi).
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (auth.jwt() ->> 'role'),
    session_user
  );
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF v_uid IS NOT NULL AND public.has_role(v_uid, 'admin') THEN
    RETURN NEW;
  END IF;

  IF NEW.valor        IS DISTINCT FROM OLD.valor        THEN RAISE EXCEPTION 'No tienes permiso para modificar el valor del pedido'; END IF;
  IF NEW.flete        IS DISTINCT FROM OLD.flete        THEN RAISE EXCEPTION 'No tienes permiso para modificar el flete'; END IF;
  IF NEW.costo_prod   IS DISTINCT FROM OLD.costo_prod   THEN RAISE EXCEPTION 'No tienes permiso para modificar el costo del producto'; END IF;
  IF NEW.costo_dev    IS DISTINCT FROM OLD.costo_dev    THEN RAISE EXCEPTION 'No tienes permiso para modificar el costo de devolucion'; END IF;
  IF NEW.assigned_to  IS DISTINCT FROM OLD.assigned_to  THEN RAISE EXCEPTION 'No tienes permiso para reasignar pedidos'; END IF;
  IF NEW.external_id  IS DISTINCT FROM OLD.external_id  THEN RAISE EXCEPTION 'No tienes permiso para modificar el ID externo'; END IF;
  IF NEW.created_at   IS DISTINCT FROM OLD.created_at   THEN RAISE EXCEPTION 'No tienes permiso para modificar la fecha de creación'; END IF;

  RETURN NEW;
END;
$$;