import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import { emitirGestion } from '@/lib/eventosGestion';
import { useBitacoraPedido } from '@/hooks/useBitacoraPedido';

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
 * Devuelve `{ ok, fila }` (nunca lanza: el llamador degrada sin romper la
 * pantalla). Ver `ResultadoGestion` para por qué son DOS datos y no uno.
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

/**
 * ⛔ "SE GUARDÓ" y "ME DEVOLVIÓ LA FILA" son dos preguntas distintas.
 *
 * Antes esto devolvía la fila a secas y el llamador decidía con `if (fila)`. Un
 * INSERT que entra pero cuyo `.select()` vuelve vacío —RLS de lectura, respuesta
 * recortada— le mostraba a la asesora **"No se pudo registrar. Reintentá."**
 * sobre una gestión que SÍ quedó guardada. Y con el candado anti-duplicado de
 * acá abajo el error se volvía pegajoso: el reintento dentro del minuto no
 * inserta nada y repite el mismo cartel.
 *
 * `ok` sale de que la base NO devolvió error. `fila` es un extra: sirve para
 * pintar el touchpoint al instante (`CrmTable`) y puede venir null sin que eso
 * signifique que falló.
 */
export interface ResultadoGestion {
  /** La base aceptó la gestión (o ya estaba registrada hace segundos). */
  ok: boolean;
  /** La fila insertada, si la base la devolvió. `null` NO significa fallo. */
  fila: FilaTouchpoint;
}

const FALLO: ResultadoGestion = { ok: false, fila: null };

const ULTIMA_GESTION = new Map<string, { at: number; resultado: ResultadoGestion }>();
const VENTANA_ANTIDUP_MS = 60_000;

export function useRecordGestion() {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const bitacora = useBitacoraPedido();

  return useCallback(
    /**
     * `externalId` es OPCIONAL y solo alimenta la bitácora (`order_events`).
     *
     * ⛔ No se agrega a `touchpoints`: esa tabla se guarda por teléfono, la
     * consultan siete pantallas y varias RPC desplegadas, y cambiarle la forma
     * es DDL sobre una tabla caliente (REGLA #0). El número de pedido —que es
     * lo que faltaba para saber SOBRE CUÁL pedido fue la gestión cuando el
     * cliente tiene dos— va en la bitácora, que nació con él.
     *
     * Cuando el llamador no lo pasa, la gestión se registra igual: queda sin
     * pedido, que es exactamente lo que pasaba antes. Nunca se inventa.
     */
    async (phone: string, module: GestionModule, action: string, externalId?: string | null): Promise<ResultadoGestion> => {
      if (!user || !activeStoreId || !phone) return FALLO;

      // ⛔ Repetición reciente: se DESCARTA el INSERT pero se devuelve `ok`.
      // Para la pantalla el clic funcionó — la gestión ya está registrada.
      // Devolver un fallo mostraría "No se pudo registrar, reintentá" sobre algo
      // que sí se guardó, y la asesora insistiría: el error opuesto y peor.
      const llave = `${activeStoreId}|${phone}|${module}: ${action}`;
      const previa = ULTIMA_GESTION.get(llave);
      if (previa && Date.now() - previa.at < VENTANA_ANTIDUP_MS) return previa.resultado;

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
      // ⛔ El veredicto lo da `error`, NO si volvió la fila. Ver `ResultadoGestion`.
      if (error) return FALLO;
      const resultado: ResultadoGestion = { ok: true, fila: data?.[0] ?? null };
      const fila = resultado.fila;
      ULTIMA_GESTION.set(llave, { at: Date.now(), resultado });
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
        at: fila?.created_at || now.toISOString(),
      });
      // La bitácora va DESPUÉS y por separado: es un espejo para poder
      // reconstruir el turno, no la gestión en sí. Si falla, la gestión ya está
      // guardada y los contadores ya se movieron — no puede arrastrar nada.
      // `LLAMADA`/`WHATSAPP` no son gestiones sino intentos de contacto, así que
      // van con su propio nombre: contarlos como gestión en la bitácora sería
      // repetir en otra tabla la confusión que el prefijo evita en ésta.
      bitacora(
        module === 'LLAMADA' ? 'llamo' : module === 'WHATSAPP' ? 'escribio' : 'gestiono',
        { externalId, phone, detalle: { modulo: module, accion: action } },
      );
      return resultado;
    },
    [user, activeStoreId, bitacora],
  );
}
