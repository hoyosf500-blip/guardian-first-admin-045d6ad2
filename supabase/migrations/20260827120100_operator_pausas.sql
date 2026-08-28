-- ═══════════════════════════════════════════════════════════════════════════
-- "Estoy en otra cosa": que el asesor pueda decir en qué se le fue el tiempo.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 27-ago-2026. El dueño le escribió a un asesor *"llevás una hora sin marcar
-- una acción en el CRM, ¿pasa algo?"* y la respuesta fue *"estoy revisando las
-- guías de retiro en agencia de Servientrega… estoy intentando llamarles
-- también"*. Estaba trabajando.
--
-- Guardian no tenía cómo saberlo: `useInactivityGuard` mide mousemove/keydown
-- SOBRE LA VENTANA DE GUARDIAN. Una hora en el sitio de Servientrega o al
-- teléfono con el celular en la mano se ve idéntica a una hora sin hacer nada,
-- y al tercer aviso la pantalla se BLOQUEA 5 minutos y queda fila en
-- `operator_inactivity_warnings` — que el dueño lee como "Avisos sin trabajar".
--
-- Cuando el sistema no puede ver, tiene dos opciones: acusar o preguntar.
-- Esta tabla es preguntar. **La pausa no borra el hueco, lo NOMBRA**: el dueño
-- pasa de "estuvo una hora quieto" a "estuvo una hora en la agencia", que es un
-- dato con el que sí se puede decidir algo.
--
-- Por qué tabla propia y no `touchpoints`: `touchpoints.phone` es NOT NULL
-- (20260413041155:92) y meterle un teléfono inventado para colgar una pausa
-- sería ensuciar la tabla de gestiones con filas que no son gestiones — y de
-- paso inflar todo contador que cuente `SEG:%`.
--
-- El tope de 45 min NO vive acá sino en `src/lib/pausaTrabajo.ts`
-- (`PAUSA_MAX_MS`), que es puro y testeado: una pausa vieja se ignora sin
-- necesidad de que nadie la cierre. La base guarda el hecho; la regla de hasta
-- cuándo vale se puede cambiar sin migración.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.operator_pausas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- Texto libre a propósito: la lista de motivos vive en el cliente y va a
  -- crecer. Un CHECK acá obligaría a una migración por cada motivo nuevo, y un
  -- motivo rechazado en producción le rompe el botón al asesor.
  motivo      text NOT NULL,
  nota        text,
  inicio      timestamptz NOT NULL DEFAULT now(),
  fin         timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_pausas_fin_despues CHECK (fin IS NULL OR fin >= inicio)
);

GRANT SELECT, INSERT, UPDATE ON public.operator_pausas TO authenticated;
GRANT ALL ON public.operator_pausas TO service_role;

-- Lectura del panel del dueño: "las pausas de esta tienda, hoy".
CREATE INDEX IF NOT EXISTS idx_pausas_store_inicio
  ON public.operator_pausas (store_id, inicio DESC);
-- La consulta caliente del cliente: "¿tengo una pausa abierta?".
CREATE INDEX IF NOT EXISTS idx_pausas_abiertas
  ON public.operator_pausas (operator_id, store_id, inicio DESC)
  WHERE fin IS NULL;

ALTER TABLE public.operator_pausas ENABLE ROW LEVEL SECURITY;

-- Mismo alcance que `operator_inactivity_warnings` (20260626120000:25-37): la
-- propia, la del admin global, y la de quien manda en esa tienda.
DROP POLICY IF EXISTS pausas_select_scope ON public.operator_pausas;
CREATE POLICY pausas_select_scope ON public.operator_pausas
  FOR SELECT TO authenticated
  USING (
    operator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
    OR EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.store_id = operator_pausas.store_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','supervisor')
    )
  );

-- Solo se declara la PROPIA pausa, y solo en una tienda de la que se es
-- miembro. Nadie pausa a nombre de otro: sería falsificar la explicación de un
-- hueco ajeno.
DROP POLICY IF EXISTS pausas_insert_propia ON public.operator_pausas;
CREATE POLICY pausas_insert_propia ON public.operator_pausas
  FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid() AND public.is_store_member(store_id));

-- UPDATE existe SOLO para cerrarla (poner `fin`). El WITH CHECK repite la
-- condición de dueño para que un UPDATE no pueda reasignarle la pausa a otra
-- persona ni moverla de tienda.
DROP POLICY IF EXISTS pausas_update_propia ON public.operator_pausas;
CREATE POLICY pausas_update_propia ON public.operator_pausas
  FOR UPDATE TO authenticated
  USING (operator_id = auth.uid())
  WITH CHECK (operator_id = auth.uid() AND public.is_store_member(store_id));

COMMENT ON TABLE public.operator_pausas IS
  'Pausas declaradas por el asesor ("estoy en la agencia"). No borran el hueco de inactividad: lo explican. Ver src/lib/pausaTrabajo.ts para el tope de vigencia.';
