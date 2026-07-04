-- Jornada "HORAS REALES por evidencia de trabajo" (decisión del dueño 2026-07-03).
--
-- PROBLEMA que resuelve: la Jornada medía "mouse/teclado en la pestaña del CRM"
-- (useOperatorHeartbeat). Para una operadora que trabaja POR TELÉFONO/WhatsApp,
-- eso subcuenta grave: hablar con el cliente y confirmar por chat pasa con el CRM
-- quieto o en segundo plano → el tiempo real "cae" en el hueco "sin CRM abierto",
-- no en Activo/Inactivo. Resultado: "Activo 2h5m / Inactivo 2m / 10h46m sin CRM"
-- que no responde "¿cuántas horas me trabajó?".
--
-- ESTA RPC responde esa pregunta con el dato en el que SÍ confiamos: las acciones
-- de trabajo con su hora exacta (order_results + touchpoints). Agrupa esos eventos
-- en BLOQUES: mientras las acciones consecutivas estén a < 15 min una de otra, es
-- un mismo bloque de trabajo (los ratos marcando/llamando entre confirmaciones
-- quedan adentro); un hueco > 15 min corta el bloque. "Trabajó" = suma de bloques.
--
-- Ej: confirma 22 pedidos 9:12→13:40 sin cortes > 15min = 1 bloque de 4h28; vuelve
-- 18:30→20:18 = otro bloque de 1h48 → trabajó 6h16 en 2 bloques. Un pico temprano
-- suelto (abrir el CRM 7:24 "a chequear") NO infla nada: sin acciones cerca, no hay
-- bloque. Es lo opuesto al viejo % que anclaba la ventana en el primer mousemove.
--
-- Store-scoped con HARD-STOP (nunca mezcla CO+EC — ver 20260626150000) y excluye
-- admins globales, igual que operator_activity_stats.

CREATE OR REPLACE FUNCTION public.operator_worked_blocks(p_range text DEFAULT 'today')
RETURNS TABLE(
  operator_id uuid,
  display_name text,
  worked_seconds bigint,
  block_count int,
  first_event timestamptz,
  last_event timestamptz,
  blocks jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_since date;
  v_store uuid;
  -- Corta el bloque si hay más de 15 min sin ninguna acción registrada. Cubre el
  -- rato dialando/hablando/esperando entre confirmaciones (que no deja evento) sin
  -- fusionar dos turnos separados por un almuerzo o una ausencia larga.
  c_gap_sec       constant int := 15 * 60;
  -- Una acción suelta (bloque de 1 evento → span 0s) cuenta como ~2 min de trabajo:
  -- confirmar un pedido implica un rato de gestión aunque no haya otro evento cerca.
  c_min_block_sec constant int := 120;
BEGIN
  v_store := public._resolve_scope_store();
  -- Sin tienda concreta (admin sin tienda activa / race) → 0 filas, nunca mezclar.
  IF v_store IS NULL THEN
    RETURN;
  END IF;

  v_since := CASE p_range
    WHEN 'today' THEN ((NOW() AT TIME ZONE 'America/Bogota')::date)
    WHEN '7d'    THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)
    WHEN '30d'   THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)
    ELSE ((NOW() AT TIME ZONE 'America/Bogota')::date)
  END;

  RETURN QUERY
  WITH ev AS (
    -- Cada acción de trabajo con su hora exacta (una fila por evento). Filtramos
    -- por fecha Bogotá del created_at para alinear con el resto del dashboard.
    SELECT r.operator_id AS op, r.created_at AS ts
    FROM public.order_results r
    WHERE r.store_id = v_store
      AND (r.created_at AT TIME ZONE 'America/Bogota')::date >= v_since
    UNION ALL
    SELECT t.operator_id AS op, t.created_at AS ts
    FROM public.touchpoints t
    WHERE t.store_id = v_store
      AND (t.created_at AT TIME ZONE 'America/Bogota')::date >= v_since
  ),
  ev2 AS (
    -- Excluir admins globales: el dashboard "Por operadora" es de operadoras.
    SELECT e.op, e.ts
    FROM ev e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = e.op AND ur.role = 'admin'
    )
  ),
  flagged AS (
    -- new_block = 1 en el primer evento del operador y cada vez que el gap con el
    -- evento anterior supera el umbral. Islands & gaps clásico.
    SELECT op, ts,
      CASE
        WHEN LAG(ts) OVER (PARTITION BY op ORDER BY ts) IS NULL
          OR ts - LAG(ts) OVER (PARTITION BY op ORDER BY ts) > make_interval(secs => c_gap_sec)
        THEN 1 ELSE 0
      END AS new_block
    FROM ev2
  ),
  grouped AS (
    -- id de bloque = suma acumulada de new_block (ROWS: estable ante timestamps iguales).
    SELECT op, ts,
      SUM(new_block) OVER (PARTITION BY op ORDER BY ts ROWS UNBOUNDED PRECEDING) AS block_id
    FROM flagged
  ),
  blocks_agg AS (
    SELECT op, block_id,
      MIN(ts) AS b_start,
      MAX(ts) AS b_end,
      COUNT(*)::int AS events,
      GREATEST(
        EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts)))::int,
        c_min_block_sec
      ) AS dur_sec
    FROM grouped
    GROUP BY op, block_id
  )
  SELECT
    b.op AS operator_id,
    COALESCE(p.display_name, 'Sin nombre') AS display_name,
    SUM(b.dur_sec)::bigint AS worked_seconds,
    COUNT(*)::int AS block_count,
    MIN(b.b_start) AS first_event,
    MAX(b.b_end)   AS last_event,
    jsonb_agg(
      jsonb_build_object(
        'start', b.b_start,
        'end',   b.b_end,
        'events', b.events,
        'sec',   b.dur_sec
      ) ORDER BY b.b_start
    ) AS blocks
  FROM blocks_agg b
  LEFT JOIN public.profiles p ON p.user_id = b.op
  GROUP BY b.op, p.display_name
  ORDER BY MIN(b.b_start) ASC;
END $$;

GRANT EXECUTE ON FUNCTION public.operator_worked_blocks(text) TO authenticated;
