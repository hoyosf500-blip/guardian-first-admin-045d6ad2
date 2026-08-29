import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import { emitirGestion } from '@/lib/eventosGestion';

// SEG/RESCUE/NOVEDAD son GESTIONES (cuentan como trabajo resuelto/tocado).
// LLAMADA/WHATSAPP son INTENTOS DE CONTACTO — se registran para que el trabajo
// telefónico deje de ser invisible, pero con prefijo propio para NO contar como
// gestión ni ocultar tarjetas (no matchean 'SEG:%' ni el módulo confirmar).
// REAGENDA es la venta APLAZADA: el cliente quiere el pedido pero después. Va con
// prefijo propio a propósito — no es una cancelación (no escribe order_results, no
// toca orders.estado) y tampoco es una gestión cerrada: el pedido sigue vivo y
// vuelve solo a la cola el día del recordatorio. Lo escribe useReagendarPedido.
export type GestionModule = 'SEG' | 'RESCUE' | 'NOVEDAD' | 'LLAMADA' | 'WHATSAPP' | 'REAGENDA';

/**
 * Inserta un touchpoint de gestión `MODULE: acción` (store-scoped, con el
 * operador actual y la fecha Bogotá). Es la ÚNICA forma de escribir una gestión:
 * la lista (CrmTable), el tablero kanban (SegBoard) y el detalle comparten este
 * hook para que TODO contador la reconozca igual — SegCounterBar
 * (`action LIKE 'SEG:%'`), `operator_productivity_stats` y el set
 * `mySegTouchedToday` de OrderContext (que oculta la tarjeta gestionada vía el
 * realtime sobre touchpoints).
 *
 * El bug que motivó extraerlo (2026-07-30): el kanban NO tenía dónde marcar, así
 * que una asesora que trabajaba desde el tablero no registraba nada y su
 * contador no se movía. Duplicar el formato del INSERT es exactamente lo que lo
 * causaría de nuevo — por eso vive en un solo lugar.
 *
 * Devuelve la fila insertada, o null si faltó teléfono/tienda/usuario o falló el
 * INSERT (nunca lanza: el llamador degrada sin romper la pantalla).
 */
/**
 * Anti-duplicado, a nivel de MÓDULO (no por tarjeta).
 *
 * ── Medido en producción (28-ago-2026) ──────────────────────────────────────
 * El pedido 6637528 (Soledad Zubiria) tiene TRES filas
 * `SEG: Reclamé transportadora` con el mismo minuto: 27-ago 20:04. Un clic
 * contó tres veces, y eso le infla la productividad a quien lo hizo.
 *
 * `touchpoints` no tiene constraint anti-duplicado (está documentado), y el
 * guard `enVueloRef` de `SegCard` es **por instancia de tarjeta**: no ve el caso
 * del mismo teléfono dibujado en más de una tarjeta, que es justo cuando pasa.
 * Por eso la llave vive acá, fuera de todo componente.
 *
 * El candado es de CLIENTE a propósito. Un UNIQUE sobre `touchpoints` es DDL en
 * una tabla caliente (REGLA #0) y necesita su propia ventana.
 */
type FilaTouchpoint = { created_at?: string } | null;
const ULTIMA_GESTION = new Map<string, { at: number; fila: FilaTouchpoint }>();
const VENTANA_ANTIDUP_MS = 60_000;

export function useRecordGestion() {
  const { user } = useAuth();
  const { activeStoreId } = useStore();

  return useCallback(
    async (phone: string, module: GestionModule, action: string) => {
      if (!user || !activeStoreId || !phone) return null;

      // ⛔ Repetición reciente: se DESCARTA el INSERT pero se devuelve la fila
      // anterior, NO null. Para la pantalla el clic funcionó — la gestión ya
      // está registrada. Devolver null mostraría "No se pudo registrar,
      // reintentá" sobre algo que sí se guardó, y la asesora insistiría: el
      // error opuesto y peor.
      const llave = `${activeStoreId}|${phone}|${module}: ${action}`;
      const previa = ULTIMA_GESTION.get(llave);
      if (previa && Date.now() - previa.at < VENTANA_ANTIDUP_MS) return previa.fila;

      const now = new Date();
      const tp = {
        phone,
        action: `${module}: ${action}`,
        operator_id: user.id,
        store_id: activeStoreId,
        action_date: bogotaToday(),
        action_time: now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
      };
      const { data, error } = await supabase.from('touchpoints').insert(tp).select();
      if (error) return null;
      const fila = data?.[0] ?? null;
      ULTIMA_GESTION.set(llave, { at: Date.now(), fila });
      // Recién ACÁ, con la fila confirmada por la base, se avisa a la pantalla.
      // Es lo que hace que el contador baje en el acto en vez de esperar un
      // realtime que sobre `touchpoints` no existía (ver `eventosGestion.ts`).
      // Emitirlo antes del INSERT descontaría un pedido que quizá no quedó
      // registrado — el error opuesto y peor.
      emitirGestion({
        phone,
        modulo: module,
        accion: action,
        operatorId: user.id,
        at: (fila as { created_at?: string } | null)?.created_at || now.toISOString(),
      });
      return fila;
    },
    [user, activeStoreId],
  );
}
