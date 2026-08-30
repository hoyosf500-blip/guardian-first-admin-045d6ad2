-- ============================================================================
-- El mismo producto partido en dos en TODOS los reportes
-- ============================================================================
--
-- `dropi-cron` escribía `orders.producto` repitiendo el nombre por cada línea
-- del pedido: un pedido de dos tallas del mismo zapato quedaba como
-- «Sneakers 2801, Sneakers 2801». Para `logistics_by_product`,
-- `product_profitability` y el detalle por producto del Dashboard eso es un
-- producto DISTINTO de «Sneakers 2801» — el mismo zapato en dos filas, con la
-- efectividad y la rentabilidad repartidas entre las dos.
--
-- El mapper compartido (`_shared/dropiOrderMapper.ts`) ya deduplicaba; a
-- `dropi-cron` solo se le había copiado `variantLabel`. Como los dos escriben
-- la MISMA columna, el valor alternaba en cada corrida — y cada cambio
-- disparaba un evento de realtime a todos los navegadores abiertos.
--
-- El código ya está arreglado (30-ago-2026). Esto normaliza lo YA GUARDADO:
-- sin esto el histórico sigue partido y los meses cerrados tampoco cuadran.
--
-- ⛔ REGLA #0 — ESTO ES UN UPDATE SOBRE `orders`, UNA TABLA CALIENTE.
--    · `lock_timeout` corto: si no consigue el lock FALLA RÁPIDO en vez de
--      encolar a todo el mundo detrás (fue lo que congeló la base 20 min el
--      25-ago-2026).
--    · Va POR LOTES, cada uno en su propia transacción implícita.
--    · Aplicarla en un momento tranquilo, NO en hora pico con los crons
--      corriendo.
--    · Solo toca filas que de VERDAD tienen el nombre repetido — la condición
--      está en el WHERE, no después. Si son cero, no escribe nada.
-- ============================================================================

SET lock_timeout = '5s';

-- Deduplica «A, A, B» → «A, B» conservando el ORDEN DE APARICIÓN.
-- No es un DISTINCT suelto a propósito: reordenaría, y un pedido con productos
-- realmente distintos («Gafas, Reloj») cambiaría de nombre sin motivo.
CREATE OR REPLACE FUNCTION pg_temp._dedup_producto(p_texto text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(parte, ', ' ORDER BY pos)
  FROM (
    SELECT DISTINCT ON (btrim(x.parte)) btrim(x.parte) AS parte, x.pos
    FROM unnest(string_to_array(p_texto, ', ')) WITH ORDINALITY AS x(parte, pos)
    WHERE btrim(x.parte) <> ''
    ORDER BY btrim(x.parte), x.pos
  ) p;
$$;

DO $$
DECLARE
  v_lote    integer := 500;
  v_tocados integer;
  v_total   integer := 0;
  v_vueltas integer := 0;
BEGIN
  LOOP
    v_vueltas := v_vueltas + 1;
    -- Freno anti-runaway: 400 × 500 = 200.000 filas.
    EXIT WHEN v_vueltas > 400;

    -- ⛔ La condición de "tiene repetidos" va DENTRO del WHERE del SELECT que
    --    arma el lote. Si filtrara después, un lote de 500 filas con coma pero
    --    SIN repetidos actualizaría 0 y el bucle saldría creyendo que terminó,
    --    dejando sin normalizar todo lo que viniera más adelante.
    WITH candidatas AS (
      SELECT o.id, pg_temp._dedup_producto(o.producto) AS limpio
      FROM orders o
      WHERE o.producto LIKE '%, %'
        AND pg_temp._dedup_producto(o.producto) IS DISTINCT FROM o.producto
      LIMIT v_lote
    )
    UPDATE orders o
       SET producto = c.limpio
      FROM candidatas c
     WHERE o.id = c.id
       AND c.limpio IS NOT NULL
       AND c.limpio <> '';

    GET DIAGNOSTICS v_tocados = ROW_COUNT;
    v_total := v_total + v_tocados;
    EXIT WHEN v_tocados = 0;
  END LOOP;

  RAISE NOTICE 'producto normalizado en % filas (% vueltas)', v_total, v_vueltas;
END $$;
