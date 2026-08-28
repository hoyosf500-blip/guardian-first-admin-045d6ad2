-- ═══════════════════════════════════════════════════════════════════════════
-- `touchpoints` entra al realtime. Nunca estuvo, y por eso el contador de
-- Seguimiento no bajaba.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ PASÓ (27-ago-2026). Una asesora marcaba "Avisé: en oficina" en el tablero
-- y el número de la columna se quedaba clavado en 83. Textual: *"sí le pongo
-- pero no baja el número"*. El dueño lo leyó como que no estaba trabajando y le
-- reclamó por WhatsApp. Era el software.
--
-- `OrderContext` tiene desde julio un handler de realtime sobre `touchpoints`
-- (canal `coverage-<store>-<user>`) que actualiza `mySegTouchedToday` y
-- `gestionSegPorTelefono` — los dos insumos de `estaGestionadoHoy`, que es lo
-- que decide si una tarjeta ya está atendida. Ese handler estaba bien escrito y
-- esperando eventos que **no llegaban nunca**: las únicas tablas publicadas eran
-- `orders` + `order_results` (20260417190216), `wa_conversations` + `wa_messages`
-- (20260623000000) y `order_labels` (20260708000000). `touchpoints` no.
--
-- El arreglo del caso PROPIO no vive acá sino en el cliente (`eventosGestion.ts`:
-- lo que la persona acaba de hacer con su dedo no puede depender de la red).
-- Esta migración cubre el caso del EQUIPO: que la gestión de una compañera baje
-- el número en la pantalla de la otra sin recargar, y que dos asesoras no
-- llamen al mismo cliente.
--
-- ⛔ REGLA #0 — `touchpoints` es tabla CALIENTE (los crons y el frontend la
-- escriben sin parar). Un DDL que se quede esperando el lock encola detrás
-- TODAS las lecturas y congela la base, como el 25-ago-2026 con `orders`.
-- Por eso:
--   · `lock_timeout = '5s'` → el DDL falla rápido en vez de hacer cola.
--     Si falla, se reintenta en un momento tranquilo; no se sube el timeout.
--   · **NO se toca `REPLICA IDENTITY`**. `FULL` toma AccessExclusiveLock, que es
--     justo el lock que tumbó la base. Y no hace falta: solo escuchamos INSERT,
--     y el payload `new` de un INSERT ya viene con todas las columnas. `FULL`
--     solo cambia lo que viaja en el `old` de UPDATE/DELETE.
--   · Es idempotente (mismo molde que `20260708000000_order_labels.sql`): si
--     alguien ya la publicó a mano desde el panel de Supabase, esto es un no-op.
--
-- Verificación de que quedó (antes y después):
--   SELECT tablename FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime' AND schemaname = 'public' ORDER BY 1;

SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'touchpoints'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.touchpoints';
  END IF;
END $$;
