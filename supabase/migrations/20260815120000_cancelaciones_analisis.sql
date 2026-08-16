-- cancelaciones_analisis — materia prima del reporte "¿por qué cancelan?".
--
-- POR QUÉ EXISTE
-- La tasa de cancelación está alta y hoy no hay forma de diagnosticarla: el
-- motivo (`order_results.reason`) se muestra crudo, fila por fila, solo en el
-- popup de UNA operadora en UN día de /admin. No existe ningún "top motivos"
-- por período en todo el CRM.
--
-- DEVUELVE FILAS CRUDAS, NO AGREGADOS — a propósito.
-- La clasificación (categoría / culpa / evitable-vs-ahorro) y todas las tasas
-- viven en TypeScript puro y testeado (src/lib/cancelTaxonomy.ts +
-- src/lib/cancelacionesResumen.ts). Misma decisión que documenta kpis_mensuales
-- (20260807160000): un número derivado en SQL no se puede testear sin red ni
-- corregir sin una migración. Y acá pesa todavía más: la taxonomía tiene que
-- poder cambiar de opinión sobre el HISTÓRICO — agregar una regla y que los
-- meses viejos se reclasifiquen solos — y eso únicamente funciona si clasifica
-- en el cliente sobre el texto crudo.
--
-- ATRIBUCIÓN: por COHORTE DE PEDIDO (`o.fecha`), y la población es exactamente
-- `_estado_bucket(o.estado) = 'cancelado'` — LA MISMA de la columna `cancelados`
-- de kpis_mensuales. Es deliberado: el total de filas de esta función tiene que
-- cuadrar al pedido con esa columna. Si no cuadra, el dueño ve dos cifras
-- distintas para lo mismo y deja de creerle a las dos.
--
-- EL AGUJERO QUE ESTA FUNCIÓN MIDE
-- Una cancelación hecha en el panel de Dropi (o por cancel_orphan_pending_orders,
-- o por dropi-nightly-reconcile) NO deja fila en `order_results` y por lo tanto
-- NO tiene motivo: el mapper de Dropi no lee ninguna razón porque la API no la
-- manda. Esas salen acá como `origen='externo'`. Ese conteo NO es un defecto del
-- reporte, es su primer hallazgo: mientras sea grande, ninguna conclusión sobre
-- motivos describe a toda la operación. Bajarlo es el KPI del proyecto.
--
-- ⛔ REGLA #1: esta función es NUEVA y no reescribe ninguna existente. En
-- particular NO toca `admin_cancelled_details` (20260626130000), que resuelve
-- otra cosa (el popup por operadora-y-día de Reportes diarios). Se agrega al lado.
--
-- AMBIGÜEDAD 42702 (la lección de 20260807020000_fix_balance_mensual): los
-- nombres del RETURNS TABLE son variables de salida dentro del cuerpo PL/pgSQL y
-- varios (order_id, fecha, valor, estado, producto, ciudad) existen además como
-- columnas reales. Por eso el CTE `canc` renombra TODO a `c_*` y no queda una
-- sola referencia desnuda en el cuerpo.

DROP FUNCTION IF EXISTS public.cancelaciones_analisis(uuid, date, date, integer);

CREATE FUNCTION public.cancelaciones_analisis(
  p_store_id uuid,
  p_desde    date,
  p_hasta    date,
  p_limite   integer DEFAULT 3000
)
RETURNS TABLE(
  order_id            uuid,
  external_id         text,
  fecha               date,
  creado_at           timestamptz,
  estado              text,
  valor               numeric,
  producto            text,
  ciudad              text,
  departamento        text,
  transportadora      text,
  validation_decision text,
  origen              text,
  motivo              text,
  operator_id         uuid,
  operator_name       text,
  cancelado_at        timestamptz,
  primer_toque_at     timestamptz,
  intentos_previos    integer,
  intentos_noresp     integer,
  contactos_previos   integer,
  reagendas           integer,
  total_periodo       bigint,
  generados_periodo   bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- Tope EXPLÍCITO y acotado por el server. Un mes malo son cientos de filas,
  -- pero un año en la tienda grande son miles y esto se lee desde el navegador.
  v_lim integer := LEAST(GREATEST(COALESCE(p_limite, 3000), 1), 5000);
BEGIN
  -- Encargados de ESA tienda (owner/supervisor). Lleva nombres de operadoras y
  -- plata: no es vista de operadora. Mismo chokepoint que kpis_mensuales.
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta tienda' USING ERRCODE = '42501';
  END IF;

  IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH canc AS (
    SELECT
      o.id                  AS c_id,
      o.external_id         AS c_external_id,
      o.fecha::date         AS c_fecha,
      o.created_at          AS c_creado_at,
      o.estado              AS c_estado,
      o.valor               AS c_valor,
      o.producto            AS c_producto,
      o.ciudad              AS c_ciudad,
      o.departamento        AS c_departamento,
      o.transportadora      AS c_transportadora,
      o.validation_decision AS c_vd,
      o.phone               AS c_phone
    FROM public.orders o
    WHERE o.store_id = p_store_id
      -- `orders.fecha` es TEXT y no siempre confiable: guard de FORMATO, mismo
      -- patrón que kpis_mensuales / logistics_summary / admin_cancelled_details.
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date >= p_desde
      AND o.fecha::date <= p_hasta
      AND public._estado_bucket(o.estado) = 'cancelado'
  ),
  -- Total REAL del período, calculado ANTES del LIMIT. Viaja repetido en cada
  -- fila para que el cliente pueda decir "mostrando N de M" en vez de truncar en
  -- silencio. Un booleano `truncado` diría QUE falta; esto dice CUÁNTO.
  tot AS (SELECT COUNT(*)::bigint AS c_total FROM canc),
  -- EL DENOMINADOR, calculado por la MISMA función y con los MISMOS filtros.
  -- Va acá y no en el cliente a propósito: si la tasa se armara cruzando esta
  -- función con otra RPC, cualquier diferencia de filtro entre las dos daría un
  -- porcentaje imposible de auditar.
  -- Definición: pedidos CREADOS en el período, cancelados INCLUIDOS, `borrado`
  -- (REEMPLAZADA / ARCHIVADO GHOST) EXCLUIDO. Coincide con
  -- financial_summary.tasa_cancelacion_pct y DIFIERE a propósito de
  -- logistics_summary, que saca los cancelados de su total.
  gen AS (
    SELECT COUNT(*)::bigint AS c_generados
    FROM public.orders o2
    WHERE o2.store_id = p_store_id
      AND o2.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o2.fecha::date >= p_desde
      AND o2.fecha::date <= p_hasta
      AND public._estado_bucket(o2.estado) <> 'borrado'
  )
  SELECT
    c.c_id,
    c.c_external_id,
    c.c_fecha,
    c.c_creado_at,
    c.c_estado,
    c.c_valor,
    c.c_producto,
    c.c_ciudad,
    c.c_departamento,
    c.c_transportadora,
    c.c_vd,
    CASE WHEN cr.r_id IS NOT NULL THEN 'guardian' ELSE 'externo' END,
    NULLIF(btrim(COALESCE(cr.r_reason, '')), ''),
    cr.r_operator,
    pf.display_name,
    COALESCE(cr.r_at, hs.h_at),
    ag.a_primer,
    COALESCE(ag.a_intentos, 0)::integer,
    COALESCE(ag.a_noresp,   0)::integer,
    COALESCE(tp.t_contactos, 0)::integer,
    COALESCE(rg.g_reagendas, 0)::integer,
    t.c_total,
    g.c_generados
  FROM canc c
  CROSS JOIN tot t
  CROSS JOIN gen g

  -- La cancelación hecha DESDE Guardian. Hay a lo sumo una: el índice parcial
  -- order_results_unique_resolving (20260427120000) bloquea `canc` duplicado por
  -- pedido; el ORDER BY + LIMIT 1 es cinturón por si ese índice no está vivo.
  --
  -- ⚠️ A PROPÓSITO NO se filtra por r.store_id: hay filas viejas de EC/GT
  -- escritas con el store_id DEFAULT de Colombia (el modelo previo a multitienda).
  -- Filtrar acá marcaría esas cancelaciones como 'externo' y el reporte diría que
  -- Dropi canceló lo que canceló una asesora. El join por order_id (FK a
  -- orders.id) ya es exacto, y el pedido ya se probó de p_store_id en el CTE.
  LEFT JOIN LATERAL (
    SELECT r.id AS r_id, r.reason AS r_reason,
           r.operator_id AS r_operator, r.created_at AS r_at
    FROM public.order_results r
    WHERE r.order_id = c.c_id
      AND r.result   = 'canc'
    ORDER BY r.created_at DESC
    LIMIT 1
  ) cr ON true
  LEFT JOIN public.profiles pf ON pf.user_id = cr.r_operator

  -- Cuándo pasó a CANCELADO cuando NO hay fila nuestra. El trigger de
  -- order_status_history existe desde el 23-jun-2026; para pedidos anteriores
  -- solo está la fila semilla con el estado actual, así que para lo viejo esto es
  -- APROXIMADO. Mejor aproximado y dicho que NULL y mudo.
  LEFT JOIN LATERAL (
    SELECT MIN(h.changed_at) AS h_at
    FROM public.order_status_history h
    WHERE h.order_id = c.c_id
      AND public._estado_bucket(h.status) = 'cancelado'
  ) hs ON true

  -- ESFUERZO PREVIO. `a_primer` INCLUYE la propia fila de cancelación (si es la
  -- única, el primer toque ES la cancelación — que es justo lo que se quiere
  -- ver). `a_intentos` la EXCLUYE: 0 significa literalmente "se canceló sin haber
  -- llamado ni una vez", el titular más accionable de todo el reporte.
  LEFT JOIN LATERAL (
    SELECT
      MIN(r2.created_at)                                          AS a_primer,
      COUNT(*) FILTER (WHERE cr.r_id IS NULL OR r2.id <> cr.r_id) AS a_intentos,
      COUNT(*) FILTER (WHERE r2.result = 'noresp')                AS a_noresp
    FROM public.order_results r2
    WHERE r2.order_id = c.c_id
      -- Solo gestión de llamada: las filas de auditoría de edición
      -- (cambio_transportadora, cambio_valor, edicion_*) no son intentos.
      AND r2.result IN ('conf', 'canc', 'noresp')
      AND (cr.r_at IS NULL OR r2.created_at <= cr.r_at)
  ) ag ON true

  -- CONTACTOS MANUALES (tocó "Llamar" o "WhatsApp" — useRecordGestion).
  -- ⚠️ APROXIMACIÓN CONOCIDA: `touchpoints` NO tiene order_id, se cruza por
  -- teléfono. Un cliente con dos pedidos abiertos se lleva los contactos a los
  -- dos. Se acota por tienda, desde la creación del pedido y hasta la cancelación
  -- para apretarla todo lo posible. El tipo TS lo dice también: no se disfraza
  -- de exacto.
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS t_contactos
    FROM public.touchpoints tp2
    WHERE tp2.phone      = c.c_phone
      AND tp2.store_id   = p_store_id
      AND (tp2.action LIKE 'LLAMADA:%' OR tp2.action LIKE 'WHATSAPP:%')
      AND tp2.action_date >= c.c_fecha        -- usa idx_touchpoints_phone_date
      AND tp2.created_at  >= c.c_creado_at
      AND (cr.r_at IS NULL OR tp2.created_at <= cr.r_at)
  ) tp ON true

  -- REAGENDAS QUEMADAS: se le dio otra fecha y aun así terminó cancelado. Un
  -- pedido con 2+ acá es una bandera — o el motivo real nunca fue la fecha, o se
  -- está usando reagendar para no cancelar (la tasa de confirmación no incluye
  -- las reagendas en su denominador, así que reagendar la sube).
  -- El prefijo 'REAGENDA:' es el contrato que escribe useReagendarPedido.
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS g_reagendas
    FROM public.notes n
    WHERE n.order_id  = c.c_id
      AND n.note_text LIKE 'REAGENDA:%'
      AND (cr.r_at IS NULL OR n.created_at <= cr.r_at)
  ) rg ON true

  -- Si se trunca, se conserva la PLATA. La UI está obligada a avisar comparando
  -- contra total_periodo.
  ORDER BY c.c_valor DESC NULLS LAST, c.c_fecha DESC
  LIMIT v_lim;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cancelaciones_analisis(uuid, date, date, integer) TO authenticated;

COMMENT ON FUNCTION public.cancelaciones_analisis(uuid, date, date, integer) IS
  'Una fila cruda por pedido CANCELADO del período (cohorte por orders.fecha, '
  'misma población que kpis_mensuales.cancelados). origen=guardian|externo marca '
  'si hubo motivo capturado; externo = cancelado fuera del CRM (panel de Dropi / '
  'reconciliación nocturna) y por eso sin motivo. La clasificación y las tasas '
  'viven en src/lib/cancelTaxonomy.ts + src/lib/cancelacionesResumen.ts. '
  'total_periodo trae el conteo REAL previo al LIMIT: nunca truncar en silencio. '
  'contactos_previos es APROXIMADO (touchpoints se cruza por teléfono, no por pedido).';

-- Índice de apoyo para el patrón (tienda + cohorte de fecha) que ya usan también
-- kpis_mensuales y balance_mensual. Aditivo e idempotente. `orders.fecha` es TEXT
-- y el formato ISO ordena igual que la fecha, así que sirve para el rango.
-- OJO: CREATE INDEX sin CONCURRENTLY (supabase db push corre cada migración en
-- transacción) toma un lock breve de escritura sobre `orders`. Aplicar fuera del
-- horario de la operadora.
CREATE INDEX IF NOT EXISTS idx_orders_store_fecha ON public.orders (store_id, fecha);
