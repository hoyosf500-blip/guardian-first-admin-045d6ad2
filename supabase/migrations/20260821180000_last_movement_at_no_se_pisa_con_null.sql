-- ============================================================================
-- El sync BORRABA la fecha de último movimiento
-- ============================================================================
--
-- Medido en producción el 21-ago-2026: **46 de los 228 pedidos vivos** (uno de
-- cada cinco) no tienen `last_movement_at`. Los más viejos son un PENDIENTE de
-- abril-2026 en Colombia y una NOVEDAD del 23-dic-2025 en Ecuador — cuatro y
-- ocho meses parados.
--
-- Un pedido sin esa fecha queda FUERA DE TODAS LAS ALARMAS: `estaDetenido`
-- devuelve false, no entra a ninguna lista de estancados y cae al fondo del
-- orden. Es justo el pedido al que hay que ir a mirar y es el único que nadie
-- ve.
--
-- ── La cadena, verificada de punta a punta ──────────────────────────────────
--   1. `_shared/dropiOrderMapper.ts:296` → `last_movement_at: updatedAt || null`
--      y `updatedAt = String(o.updated_at || "")`. Cuando la respuesta de lista
--      de Dropi no trae `updated_at`, viaja **null**.
--   2. Esta función escribía `last_movement_at = EXCLUDED.last_movement_at`,
--      sin COALESCE — a diferencia de `productos_detalle` y `store_id`, que sí
--      lo tienen justo al lado.
--   3. Peor: el guard de abajo lleva
--      `OR orders.last_movement_at IS DISTINCT FROM EXCLUDED.last_movement_at`,
--      así que un null entrante contra una fecha buena cuenta como "cambió" y
--      **dispara el borrado**. No era un efecto colateral: era el disparador.
--
-- ── Qué cambia ──────────────────────────────────────────────────────────────
-- DOS líneas, y nada más:
--   · el SET pasa a `COALESCE(EXCLUDED.last_movement_at, orders.last_movement_at)`
--   · el guard solo considera "cambio" un valor entrante NO nulo — mismo patrón
--     que ya usa `productos_detalle` dos líneas más arriba. Sin esto, un null
--     seguiría marcando la fila como cambiada: escribiría lo mismo que ya está
--     e inflaría el `synced_count` que se muestra como "N pedidos actualizados".
--
-- ⛔ REGLA #1 — el cuerpo de acá NO salió del repo. Es el `pg_get_functiondef`
-- de la función que está corriendo (leído el 21-ago-2026), con esas dos líneas
-- cambiadas. Copiar la versión del repo habría revertido el `ON CONFLICT
-- (store_id, external_id)` de la migración 20260820140000 y devuelto la mezcla
-- de tiendas.
--
-- NO repara el histórico: los 46 pedidos ya perdieron su fecha y Dropi es el
-- único que la tiene. Se recuperan refrescándolos (botón "Refrescar desde
-- Dropi" o la repesca del nightly), no con un UPDATE inventado acá.
-- ============================================================================

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
    ON CONFLICT (store_id, external_id) DO UPDATE SET
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
      -- ⛔ ÚNICO cambio del SET (21-ago-2026): un null entrante ya no borra la
      -- fecha buena. Dropi no siempre manda `updated_at` en la respuesta de
      -- lista, y sin este COALESCE el pedido salía de todas las alarmas.
      last_movement_at = COALESCE(EXCLUDED.last_movement_at, orders.last_movement_at)
    WHERE
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
      -- ⛔ SEGUNDO cambio (21-ago-2026): un null entrante ya no cuenta como
      -- "cambió". Antes era el DISPARADOR del borrado; ahora, además, evita
      -- marcar como actualizada una fila donde no se escribe nada nuevo — ese
      -- conteo es el que la pantalla muestra como "N pedidos actualizados".
      -- Mismo patrón que `productos_detalle`, cuatro líneas más arriba.
      OR (EXCLUDED.last_movement_at IS NOT NULL
          AND orders.last_movement_at IS DISTINCT FROM EXCLUDED.last_movement_at)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM upserted;

  RETURN COALESCE(v_changed, 0);
END;
$function$;
