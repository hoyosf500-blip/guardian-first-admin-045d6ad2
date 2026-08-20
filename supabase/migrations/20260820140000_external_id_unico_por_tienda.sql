-- external_id: de UNIQUE GLOBAL a UNIQUE POR TIENDA.
--
-- EL PROBLEMA, VERIFICADO EN LA BASE EL 20-ago-2026
-- `orders_external_id_key UNIQUE (external_id)` obliga a que un número de pedido
-- exista UNA sola vez en toda la plataforma. Pero los números los asigna Dropi y
-- cada país tiene su propia secuencia: el 4231045 de Guatemala y el 4231045 de
-- Colombia son pedidos DISTINTOS de clientes distintos.
--
-- Con el unique global no chocan: se pisan. `upsert_orders_from_dropi` hace
-- `ON CONFLICT (external_id) DO UPDATE` y, entre lo que actualiza, está
-- `store_id = COALESCE(EXCLUDED.store_id, orders.store_id)`. O sea: el pedido que
-- llega segundo SE APODERA de la fila del primero — le reemplaza cliente,
-- teléfono, dirección, producto, valor y estado, y se la lleva a SU tienda. El
-- pedido original no queda duplicado: DESAPARECE del CRM de su dueño. Y en la
-- corrida siguiente el cron del otro país lo devuelve, así que la fila queda
-- rebotando entre dos empresas.
--
-- Eso viola la regla más dura de esta operación: los datos de un dueño NUNCA
-- pueden aparecerle a otro.
--
-- POR QUÉ AHORA (los rangos ya se pisan, medido el 20-ago-2026)
--   Quickly Box      899.315 – 1.239.618   (13 pedidos)
--   Encuentralo GT 1.145.315 – 1.219.530   (56 pedidos)  ← DENTRO del anterior
--   Rushmira EC    3.265.391 – 6.624.963
--   Rushmira CO    3.388.406 – 86.514.681  ← engloba a las dos de Ecuador
-- No colisionaron todavía por la poca densidad, no por diseño. Cada pedido nuevo
-- de Guatemala es otro tiro en la ruleta.
--
-- LO QUE SÍ SE VERIFICÓ Y ESTÁ LIMPIO
-- La consulta de gestiones huérfanas (order_results cuya tienda no coincide con
-- la del pedido, desde el 1-jun-2026) devolvió CERO filas: no hay evidencia de
-- que el daño ya haya ocurrido. Esto es prevención, no reparación.
--
-- ⛔ REGLA #1 — CÓMO SE ESCRIBIÓ ESTA MIGRACIÓN
-- El cuerpo de `upsert_orders_from_dropi` de acá abajo NO se copió del repo: se
-- leyó de la base con `pg_get_functiondef` el 20-ago-2026 y se cambió UNA SOLA
-- LÍNEA (la del ON CONFLICT). Copiarla del repo fue exactamente lo que el
-- 21-jul-2026 metió pedidos de Ecuador etiquetados como Colombia durante 2h30.
-- Si al aplicar esto la función desplegada ya no coincide con la de acá, PARAR y
-- volver a leerla.
--
-- SOBRE LAS DOS LÍNEAS QUE QUEDAN INERTES
-- Con el conflicto compuesto, `orders.store_id` es SIEMPRE igual a
-- `EXCLUDED.store_id` (es parte de la clave), así que el `COALESCE` del SET y la
-- primera condición del WHERE nunca hacen nada. Se dejan TAL CUAL a propósito:
-- tocar una función viva más de lo estrictamente necesario es cómo se rompen las
-- cosas. Quedan documentadas, no borradas.

-- ── Paso 0: fail-closed ────────────────────────────────────────────────────
-- Un `store_id` NULL no lo restringe un índice compuesto (en SQL, NULL nunca es
-- igual a NULL). Si existieran filas sin tienda, quitar el unique global las
-- dejaría duplicarse libremente — cambiaríamos un problema por otro peor. Antes
-- de tocar nada, la migración se niega a seguir.
DO $$
DECLARE v_nulos bigint;
BEGIN
  SELECT COUNT(*) INTO v_nulos FROM public.orders WHERE store_id IS NULL;
  IF v_nulos > 0 THEN
    RAISE EXCEPTION
      'ABORTADA: hay % pedidos con store_id NULL. Asignarles tienda ANTES de quitar el unique global, o quedarían sin ninguna protección contra duplicados.', v_nulos;
  END IF;
END $$;

-- ── Paso 1: el índice nuevo (aditivo: convive con el viejo) ────────────────
CREATE UNIQUE INDEX IF NOT EXISTS orders_store_external_uk
  ON public.orders (store_id, external_id);

-- ── Paso 2: la función apunta al conflicto nuevo ───────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_orders_from_dropi(p_orders jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed integer;
BEGIN
  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset(p_orders) AS x(
      external_id       text,
      store_id          uuid,
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
      external_id, store_id, uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, productos_detalle, estado, fecha, fecha_conf,
      dias, dias_conf, valor, flete, costo_prod, costo_dev, cantidad,
      direccion, novedad, guia, transportadora, tags, tienda, novedad_sol,
      last_movement_at
    )
    SELECT
      external_id, store_id, uploaded_by, upload_date, nombre, phone, ciudad,
      departamento, producto, productos_detalle, estado, fecha, fecha_conf,
      dias, dias_conf, valor, flete, costo_prod, costo_dev, cantidad,
      direccion, novedad, guia, transportadora, tags, tienda, novedad_sol,
      last_movement_at
    FROM input_rows
    -- ⬇ LA ÚNICA LÍNEA QUE CAMBIA respecto de la versión desplegada.
    -- Antes: ON CONFLICT (external_id) — un pedido de otra tienda con el mismo
    -- número se llevaba la fila puesta.
    ON CONFLICT (store_id, external_id) DO UPDATE SET
      -- Inerte con el conflicto compuesto (ver encabezado): store_id ya coincide.
      store_id         = COALESCE(EXCLUDED.store_id, orders.store_id),
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
      -- Inerte con el conflicto compuesto (ver encabezado). Se conserva.
      (EXCLUDED.store_id IS NOT NULL
       AND orders.store_id IS DISTINCT FROM EXCLUDED.store_id)
      OR orders.estado          IS DISTINCT FROM EXCLUDED.estado
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
$function$;

-- ── Paso 3: recién ahora se quita el candado global ────────────────────────
-- Va ÚLTIMO a propósito. Si se quitara primero, entre ese instante y la creación
-- del índice nuevo la tabla quedaría sin ninguna protección contra duplicados; y
-- si la función todavía apuntara al conflicto viejo, el upsert fallaría entero y
-- dejaría de entrar TODO pedido nuevo. Como la migración corre en una sola
-- transacción, los tres pasos se aplican o no se aplica ninguno.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_external_id_key;

COMMENT ON INDEX public.orders_store_external_uk IS
  'Un numero de pedido de Dropi es unico DENTRO de su plataforma de pais, no '
  'entre paises: el mismo numero puede existir en GT y en CO siendo pedidos de '
  'clientes distintos. El unique global anterior (orders_external_id_key) hacia '
  'que el segundo en llegar SOBRESCRIBIERA la fila del primero y se la llevara a '
  'su tienda — datos de un dueno apareciendo en el CRM de otro. Los rangos ya se '
  'solapan (GT 1.145.315-1.219.530 vs Quickly Box 899.315-1.239.618).';
