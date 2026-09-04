import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { OrderData } from '@/lib/orderUtils';
import { bogotaToday, horaAhoraEn } from '@/lib/utils';
import { buildNovedadAction, NovedadResultTipo } from '@/lib/novedadGestion';
import { emitirGestion } from '@/lib/eventosGestion';
import { useBitacoraPedido } from '@/hooks/useBitacoraPedido';
import { toast } from 'sonner';

/**
 * Gestión de una novedad desde /novedades.
 *
 * Historia corta, porque ya dio dos vueltas: el 23-jun-2026 los botones pasaron
 * a ser marca LOCAL (touchpoint + `orders.novedad_sol`) y el 14-ago el dueño lo
 * ratificó («la operadora resuelve en Dropi, acá solo marca»). El 29-ago lo
 * revirtió con datos en la mano: «mi panel no sirve, los botones no hacen nada
 * en Dropi». Medido ese día: `dropi-resolve-incidence` está desplegada y
 * responde, y NUNCA había recibido una llamada desde /novedades (cero filas en
 * `sync_logs`); el equipo dejó de usar el panel (5 marcas en todo agosto).
 *
 * Ahora, con `dropi: true` (incidencia ABIERTA en Dropi):
 *  - resuelta   → `dropi-resolve-incidence` action=reoffer con la nota como
 *                 solución (Dropi la exige: «solo VOLVER A OFRECER» es solución
 *                 no efectiva según su guía oficial).
 *  - devolucion → action=return.
 *  - Solo si Dropi ACEPTA se escribe la marca local y la novedad sale de la
 *    cola. Si rechaza, la novedad SE QUEDA y el error se muestra tal cual —
 *    nada de «marcada ✓» en azul sobre algo que no llegó. El intento queda en
 *    `sync_logs` (lo escribe la edge function).
 * Con `dropi: false` (incidencia ya cerrada por la transportadora: Dropi la
 * rechaza sí o sí) se comporta como antes: registro local solamente.
 *  - sin_respuesta → siempre local: registra el INTENTO y deja la novedad en cola.
 */
export type DropiResultado = 'ok' | 'rechazado' | 'sin_red' | 'no_aplica';

export interface MarcaResultado {
  /** La gestión quedó registrada (y, si aplicaba, aceptada por Dropi). */
  ok: boolean;
  dropi: DropiResultado;
  /** Texto del rechazo/error de Dropi, para mostrarlo tal cual. */
  mensaje?: string;
}

async function mensajeDeInvoke(err: unknown): Promise<string> {
  // supabase-js envuelve el 4xx/5xx en FunctionsHttpError con el body en
  // `context` (un Response). Ahí viene el `error` legible de la función.
  const ctx = (err as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const b = (await ctx.clone().json()) as { error?: string; message?: string };
      if (b?.error || b?.message) return String(b.error || b.message);
    } catch { /* body no-JSON */ }
  }
  return err instanceof Error ? err.message : String(err ?? 'error');
}

export function useMarkNovedadResolved() {
  const { user } = useAuth();
  const { activeStoreId, activeStore } = useStore();
  const bitacora = useBitacoraPedido();
  const [marking, setMarking] = useState<string | null>(null);

  const markNovedad = useCallback(
    async (
      order: OrderData,
      tipo: NovedadResultTipo,
      nota?: string,
      opts?: { dropi?: boolean },
    ): Promise<MarcaResultado> => {
      if (!user || !order) return { ok: false, dropi: 'no_aplica' };
      const key = order.dbId || order.externalId || order.phone;
      setMarking(key);
      // ⛔ Día de BOGOTÁ, la misma vara que TODOS los lectores (`useLiveTeam`,
      // `SegCounterBar`, la cobertura, el mapa de calor) y que el trigger que
      // protege la novedad resuelta del próximo sync (`20260903200000`). El
      // 4-sep se pasó a la zona de la tienda para que una gestión de las
      // 23:15 en Guatemala no se anotara "mañana"; pero con los lectores en
      // Bogotá esa marca no aparecía en NINGÚN día y el trigger no la
      // protegía. Mover todo a la zona de la tienda es otra tanda; a medias, no.
      const today = bogotaToday();
      const now = horaAhoraEn('CO');
      const solution = (nota || '').replace(/\s+/g, ' ').trim();
      const vaADropi = !!opts?.dropi && tipo !== 'sin_respuesta' && !!order.externalId;
      let dropi: DropiResultado = 'no_aplica';
      try {
        if (vaADropi) {
          const action = tipo === 'resuelta' ? 'reoffer' : 'return';
          if (action === 'reoffer' && solution.length < 3) {
            toast.error('Para mandarla a Dropi escribí la solución: qué se acordó con el cliente (dirección corregida, horario, quién recibe).');
            return { ok: false, dropi: 'no_aplica' };
          }
          const toastId = `novedad-${order.externalId}`;
          toast.loading('Enviando la solución a Dropi…', { id: toastId });
          try {
            const res = await supabase.functions.invoke('dropi-resolve-incidence', {
              // storeId: el número de pedido ya no identifica una tienda
              // (20260820140000). Sin esto se podría re-ofrecer el pedido de
              // OTRA empresa con el mismo número.
              body: action === 'reoffer'
                ? { externalId: order.externalId, storeId: activeStoreId, action, solution }
                : { externalId: order.externalId, storeId: activeStoreId, action },
            });
            const data = res?.data as { ok?: boolean; error?: string; message?: string } | null | undefined;
            if (res?.error) {
              const msg = await mensajeDeInvoke(res.error);
              toast.error(`Dropi NO aceptó la solución: ${msg}. La novedad sigue en la cola.`, { id: toastId, duration: 10000 });
              return { ok: false, dropi: 'rechazado', mensaje: msg };
            }
            if (data?.ok === false) {
              const msg = data.error || 'Dropi no aceptó';
              toast.error(`Dropi NO aceptó la solución: ${msg}. La novedad sigue en la cola.`, { id: toastId, duration: 10000 });
              return { ok: false, dropi: 'rechazado', mensaje: msg };
            }
            toast.success(action === 'reoffer' ? 'Dropi recibió la solución ✓' : 'Dropi recibió la devolución ✓', { id: toastId, duration: 3000 });
            dropi = 'ok';
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            toast.error(`No se pudo hablar con Dropi (${msg}). La novedad sigue en la cola.`, { id: toastId, duration: 10000 });
            return { ok: false, dropi: 'sin_red', mensaje: msg };
          }
        }

        // 1. Marca (touchpoint) — el registro de accountability. Dice si fue a Dropi.
        const action = tipo === 'devolucion'
          ? (dropi === 'ok' ? 'NOVEDAD: Devolución [Dropi ✓]' : 'NOVEDAD: Devolución')
          : buildNovedadAction(tipo, dropi === 'ok' ? `${solution} [Dropi ✓]` : nota);
        // Un solo sitio de inserción, con la tienda explícita en el payload
        // (es lo que audita `aislamientoTiendasEstatico`).
        const insertarMarca = () => supabase.from('touchpoints').insert({
          phone: order.phone,
          action,
          operator_id: user.id,
          action_date: today,
          action_time: now,
          store_id: activeStoreId,
        }).select('created_at');
        let tpRes = await insertarMarca();
        // Un solo reintento, y solo cuando Dropi YA aceptó: en ese caso la
        // gestión existe en la transportadora y perder la marca por un blip de
        // red deja a la asesora sin prueba de lo que hizo.
        if (tpRes.error && dropi === 'ok') tpRes = await insertarMarca();
        const marcaGuardada = !tpRes.error;
        if (!marcaGuardada) toast.error('No se pudo guardar la marca: ' + (tpRes.error?.message ?? 'error'));

        // ⛔ Si la marca falló y Dropi NO intervino, no quedó nada escrito: se
        // corta acá y la pantalla NO descarta la card. Pero si Dropi ya aceptó,
        // se sigue igual al paso 2 — antes se devolvía `ok:true` SIN llegar al
        // UPDATE de `orders` (4-sep-2026): la novedad ya estaba resuelta en la
        // transportadora y la fila seguía con `novedad_sol=false`, así que volvía
        // a la cola y OTRA asesora llamaba al mismo cliente por lo mismo.
        if (!marcaGuardada && dropi !== 'ok') return { ok: false, dropi };

        // 2. Resuelta/Devolución salen de la cola. Sin respuesta queda pendiente.
        //    Con Dropi aceptado se sella también el estado (activa el trigger
        //    que protege la gestión contra el próximo sync).
        let filaActualizada = false;
        if (tipo !== 'sin_respuesta' && order.dbId) {
          const patch = dropi === 'ok'
            ? { novedad_sol: true, estado: 'NOVEDAD SOLUCIONADA' }
            : { novedad_sol: true };
          const { error: upError } = await supabase.from('orders').update(patch).eq('id', order.dbId);
          if (upError) toast.error('No salió de la cola: ' + upError.message);
          filaActualizada = !upError;
        }

        if (marcaGuardada) {
          // Recién ACÁ, con la fila confirmada por la base, se avisa a la
          // pantalla: es lo que refresca el sello «ya lo tocó» (`useSelloGestion`
          // escucha este evento) sin esperar un realtime que sobre `touchpoints`
          // no existe. Mismo molde que `useRecordGestion` — este hook era el
          // único que insertaba touchpoints directo y en silencio.
          emitirGestion({
            phone: order.phone,
            modulo: 'NOVEDAD',
            accion: action.replace(/^NOVEDAD:\s*/, ''),
            operatorId: user.id,
            at: (tpRes.data?.[0] as { created_at?: string } | undefined)?.created_at || new Date().toISOString(),
          });
          // Y la bitácora, aparte: sin el `gestiono` la ficha de la asesora decía
          // que abrió veinte novedades y las «saltó» todas, aunque hubiera
          // resuelto tres. Es un espejo; si falla no arrastra la gestión.
          bitacora('gestiono', {
            externalId: order.externalId,
            phone: order.phone,
            detalle: { modulo: 'NOVEDAD', accion: action, dropi },
          });
        }

        // `ok:false` SOLO cuando no quedó NADA escrito. Con Dropi aceptado, la
        // gestión existe aunque acá haya fallado algo: descartar la card es lo
        // correcto, y el toast de arriba ya dijo qué faltó.
        return { ok: marcaGuardada || filaActualizada || dropi === 'ok', dropi };
      } finally {
        setMarking(null);
      }
    },
    [user, activeStoreId, bitacora],
  );

  return { markNovedad, marking };
}
