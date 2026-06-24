-- Re-clasifica los movimientos de wallet que quedaron en categoria='otro' por el
-- bug histórico del mapeo (clasificaba sobre `codigo` truncado en el primer ":",
-- y/o se sincronizaron ANTES de que existieran los patrones de retiro/mantenimiento/
-- indemnización/transferencia añadidos el 2026-05-02). Arreglar el mapeo (Parte 1,
-- en _shared/walletCategoria.ts) solo afecta movimientos FUTUROS; estas filas viejas
-- siguen mal hasta este UPDATE.
--
-- SEGURIDAD (datos financieros):
--   · El UPDATE toca SOLO categoria='otro'. NO toca ninguna fila ya bien clasificada.
--   · Las filas en 'otro' que NO matcheen ninguna regla se QUEDAN en 'otro'.
--   · Idempotente: tras la 1ª corrida ya no quedan 'otro' que matcheen → re-correr = 0 filas.
--   · El RPC operativo_mes_cohorte NO se toca: ya resta costo_devolucion y
--     mantenimiento_tarjeta, así que al re-etiquetar esos costos empiezan a
--     descontarse solos. retiro/deposito NO entran al operativo (correcto).
--
-- Las reglas y su ORDEN replican mapCategoria() de _shared/walletCategoria.ts.
-- ILIKE es accent-sensitive → los patrones se cortan antes de la vocal acentuada
-- ('%DEVOLUC%' matchea DEVOLUCION y DEVOLUCIÓN; '%INDEMNIZAC%'; '%COMISI%').

-- ============================================================================
-- ANTES: contar, por categoría destino, cuántas filas en 'otro' se van a tocar.
-- ============================================================================
DO $$
DECLARE
  r RECORD;
  v_total int := 0;
BEGIN
  RAISE NOTICE '== Re-clasificación wallet categoria=otro — ALCANCE (antes de aplicar) ==';
  FOR r IN
    SELECT
      CASE
        WHEN descripcion ILIKE '%TRANSFERENCIA%' AND descripcion ILIKE '%AL USUARIO%' THEN 'retiro'
        WHEN descripcion ILIKE '%TRANSFERENCIA%' AND descripcion ILIKE '%DESDE%'       THEN 'deposito'
        WHEN descripcion ILIKE '%GANANCIA%'      AND descripcion ILIKE '%DROPSHIPPER%' THEN 'ganancia_dropshipper'
        WHEN descripcion ILIKE '%GANANCIA%'      AND descripcion ILIKE '%PROVEEDOR%'   THEN 'ganancia_proveedor'
        WHEN descripcion ILIKE '%DEVOLUC%'       AND descripcion ILIKE '%ORDEN ENTREGADA%' THEN 'reembolso_flete'
        WHEN descripcion ILIKE '%DEVOLUC%'       AND descripcion ILIKE '%NO EFECTIV%'  THEN 'costo_devolucion'
        WHEN descripcion ILIKE '%DEVOLUC%'                                             THEN 'costo_devolucion'
        WHEN descripcion ILIKE '%FLETE INICIAL%'                                       THEN 'flete_inicial'
        WHEN descripcion ILIKE '%NUEVA ORDEN%'                                         THEN 'orden_sin_recaudo'
        WHEN descripcion ILIKE '%CAMBIO DE ESTATUS%'                                   THEN 'cobro_entrega'
        WHEN descripcion ILIKE '%MANTENIMIENTO%'                                       THEN 'mantenimiento_tarjeta'
        WHEN descripcion ILIKE '%INDEMNIZAC%'                                          THEN 'indemnizacion'
        WHEN descripcion ILIKE '%COMISI%'        AND descripcion ILIKE '%REFERIDO%'    THEN 'comision_referidos'
        WHEN descripcion ILIKE '%RETIRO%'                                              THEN 'retiro'
        WHEN descripcion ILIKE '%DEPOSITO%'      OR  descripcion ILIKE '%RECARGA%'     THEN 'deposito'
      END AS destino,
      COUNT(*) AS n
    FROM public.dropi_wallet_movements
    WHERE categoria = 'otro'
    GROUP BY 1
    ORDER BY 2 DESC
  LOOP
    IF r.destino IS NULL THEN
      RAISE NOTICE '  % filas -> (sin regla, se quedan en otro)', r.n;
    ELSE
      RAISE NOTICE '  % filas -> %', r.n, r.destino;
      v_total := v_total + r.n;
    END IF;
  END LOOP;
  RAISE NOTICE '  TOTAL a re-clasificar: %', v_total;
END $$;

-- ============================================================================
-- UPDATE: re-clasifica SOLO categoria='otro'. ELSE deja 'otro' intacto.
-- ============================================================================
UPDATE public.dropi_wallet_movements
SET categoria = CASE
    WHEN descripcion ILIKE '%TRANSFERENCIA%' AND descripcion ILIKE '%AL USUARIO%' THEN 'retiro'
    WHEN descripcion ILIKE '%TRANSFERENCIA%' AND descripcion ILIKE '%DESDE%'       THEN 'deposito'
    WHEN descripcion ILIKE '%GANANCIA%'      AND descripcion ILIKE '%DROPSHIPPER%' THEN 'ganancia_dropshipper'
    WHEN descripcion ILIKE '%GANANCIA%'      AND descripcion ILIKE '%PROVEEDOR%'   THEN 'ganancia_proveedor'
    WHEN descripcion ILIKE '%DEVOLUC%'       AND descripcion ILIKE '%ORDEN ENTREGADA%' THEN 'reembolso_flete'
    WHEN descripcion ILIKE '%DEVOLUC%'       AND descripcion ILIKE '%NO EFECTIV%'  THEN 'costo_devolucion'
    WHEN descripcion ILIKE '%DEVOLUC%'                                             THEN 'costo_devolucion'
    WHEN descripcion ILIKE '%FLETE INICIAL%'                                       THEN 'flete_inicial'
    WHEN descripcion ILIKE '%NUEVA ORDEN%'                                         THEN 'orden_sin_recaudo'
    WHEN descripcion ILIKE '%CAMBIO DE ESTATUS%'                                   THEN 'cobro_entrega'
    WHEN descripcion ILIKE '%MANTENIMIENTO%'                                       THEN 'mantenimiento_tarjeta'
    WHEN descripcion ILIKE '%INDEMNIZAC%'                                          THEN 'indemnizacion'
    WHEN descripcion ILIKE '%COMISI%'        AND descripcion ILIKE '%REFERIDO%'    THEN 'comision_referidos'
    WHEN descripcion ILIKE '%RETIRO%'                                              THEN 'retiro'
    WHEN descripcion ILIKE '%DEPOSITO%'      OR  descripcion ILIKE '%RECARGA%'     THEN 'deposito'
    ELSE categoria  -- sin regla: se queda en 'otro'
  END
WHERE categoria = 'otro'
  AND (
        descripcion ILIKE '%TRANSFERENCIA%'
     OR descripcion ILIKE '%GANANCIA%'
     OR descripcion ILIKE '%DEVOLUC%'
     OR descripcion ILIKE '%FLETE INICIAL%'
     OR descripcion ILIKE '%NUEVA ORDEN%'
     OR descripcion ILIKE '%CAMBIO DE ESTATUS%'
     OR descripcion ILIKE '%MANTENIMIENTO%'
     OR descripcion ILIKE '%INDEMNIZAC%'
     OR (descripcion ILIKE '%COMISI%' AND descripcion ILIKE '%REFERIDO%')
     OR descripcion ILIKE '%RETIRO%'
     OR descripcion ILIKE '%DEPOSITO%'
     OR descripcion ILIKE '%RECARGA%'
  );

-- ============================================================================
-- DESPUÉS: cuántas filas quedan en 'otro' (esperado: solo movimientos
-- genuinamente desconocidos; idealmente 0).
-- ============================================================================
DO $$
DECLARE v_otro int;
BEGIN
  SELECT COUNT(*) INTO v_otro FROM public.dropi_wallet_movements WHERE categoria = 'otro';
  RAISE NOTICE '== DESPUÉS: % filas quedan en categoria=otro (sin regla que las matchee) ==', v_otro;
END $$;
