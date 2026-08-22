import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { partirRango, partirALaMitad } from '@/lib/rangoPorTramos';
import {
  summarizeCancelaciones,
  EMPTY_RESUMEN,
  type CancelacionRow,
  type CancelacionesResumen,
} from '@/lib/cancelacionesResumen';

/**
 * Lee la RPC `cancelaciones_analisis` (una fila cruda por pedido cancelado) y la
 * resume con la capa pura.
 *
 * RESILIENTE A LA MIGRACIÓN PENDIENTE (Lovable no las auto-aplica): si la RPC
 * todavía no existe, NO rompe la pantalla ni dibuja ceros — devuelve estado
 * `not_ready`. Un reporte de cancelaciones en cero se lee como "no cancelás
 * nada", que es peor que no tenerlo.
 *
 * Molde: useNovedadRootCause (mismo `ok|forbidden|not_ready|error`, mismo seqRef
 * contra respuestas fuera de orden, mismo cast laxo de `supabase.rpc` para no
 * depender de los tipos generados).
 */

/** Tope de filas del server (LEAST(...,5000) en la RPC). */
const ROW_CAP = 5000;

/**
 * Días por consulta. La RPC calcula subconsultas POR PEDIDO cancelado y su
 * costo crece más rápido que el rango: medido el 22-ago-2026 en una tienda de
 * Ecuador, 1 día 0,7 s · 3 días 2,0 s · 7 días 4,5 s · **22 días timeout**
 * (57014). Y 22 días es el rango por DEFECTO de la pantalla, así que la pestaña
 * entera decía "Falló la consulta".
 *
 * 5 y no 7 para dejar margen: 7 días ya tardaba más de la mitad del presupuesto
 * y una tienda con más volumen lo cruza. Si un tramo igual se pasa, se parte a
 * la mitad y se reintenta (ver `leerTramo`).
 */
const DIAS_POR_TRAMO = 5;

/** Cuántos tramos se consultan a la vez. Más paralelo = más timeouts. */
const TRAMOS_EN_PARALELO = 2;

export type CancelacionesStatus = 'ok' | 'forbidden' | 'not_ready' | 'error';

export interface CancelacionesFiltros {
  fromDate: string;
  toDate: string;
}

export interface CancelacionesData {
  loading: boolean;
  status: CancelacionesStatus;
  resumen: CancelacionesResumen;
  /** Filas crudas, para la tabla de detalle y el CSV. */
  rows: CancelacionRow[];
  /** true si se llegó al tope del server (hay más de las que se ven). */
  partial: boolean;
  /**
   * Días que NO se pudieron leer (la consulta se cayó incluso partida al día).
   *
   * Va a la vista y no se traga: un reporte al que le faltan tres días y no lo
   * dice es peor que uno que no carga, porque se lee como si esos días no
   * hubieran tenido cancelaciones. Cero nunca sustituye a "no se pudo medir".
   */
  diasSinLeer: string[];
  refresh: () => void;
}

function mapRow(d: Record<string, unknown>): CancelacionRow {
  return {
    orderId: d.order_id as string,
    externalId: (d.external_id as string) ?? null,
    fecha: (d.fecha as string) ?? null,
    estado: (d.estado as string) ?? null,
    valor: (d.valor as number) ?? null,
    producto: (d.producto as string) ?? null,
    ciudad: (d.ciudad as string) ?? null,
    operatorId: (d.operator_id as string) ?? null,
    operatorName: (d.operator_name as string) ?? null,
    origen: (d.origen as 'guardian' | 'externo') ?? 'externo',
    motivo: (d.motivo as string) ?? null,
    canceladoAt: (d.cancelado_at as string) ?? null,
    primerToqueAt: (d.primer_toque_at as string) ?? null,
    intentosPrevios: Number(d.intentos_previos ?? 0),
    intentosNoresp: Number(d.intentos_noresp ?? 0),
    contactosPrevios: Number(d.contactos_previos ?? 0),
    reagendas: Number(d.reagendas ?? 0),
  };
}

export function useCancelacionesAnalisis(filtros: CancelacionesFiltros): CancelacionesData {
  const { activeStoreId } = useStore();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<CancelacionesStatus>('ok');
  const [resumen, setResumen] = useState<CancelacionesResumen>(EMPTY_RESUMEN);
  const [rows, setRows] = useState<CancelacionRow[]>([]);
  const [partial, setPartial] = useState(false);
  const [diasSinLeer, setDiasSinLeer] = useState<string[]>([]);
  const seqRef = useRef(0);

  const { fromDate, toDate } = filtros;

  const load = useCallback(async () => {
    // Sin tienda activa (primer render) no se consulta: null significa
    // "todavía no sé cuál", no "todas".
    if (!activeStoreId || !fromDate || !toDate) {
      setResumen(EMPTY_RESUMEN); setRows([]); setStatus('ok');
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const rpc = (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>);

      // ── Se consulta POR TRAMOS, no de una ──────────────────────────────
      // La RPC se cae por timeout en el rango por defecto (ver DIAS_POR_TRAMO).
      // Cada tramo que igual se pase se parte a la mitad y se reintenta, hasta
      // el día suelto. Lo que ni así se pueda leer se ANOTA y se muestra.
      let fatal: 'forbidden' | 'not_ready' | 'error' | null = null;
      const sinLeer: string[] = [];
      const crudas: Record<string, unknown>[] = [];
      // Los totales del período los calcula la RPC para el RANGO QUE SE LE PIDE,
      // así que con tramos hay que sumar UNO por tramo — leerlos de `raw[0]`
      // daría solo los del primer tramo y el denominador saldría por el piso
      // (o sea, la tasa de cancelación por las nubes).
      let totalPeriodo = 0;
      let generados = 0;
      // Un tramo SIN cancelaciones no devuelve filas, y con ellas se va su
      // `generados_periodo`. Sumar de menos infla la tasa en silencio, así que
      // en ese caso el denominador se marca incompleto y se muestra "—".
      let denominadorParcial = false;

      const leerTramo = async (desde: string, hasta: string): Promise<void> => {
        // `p_limite` va EXPLÍCITO: el default de la RPC es 3000 y el chequeo de
        // truncado de acá compara contra ROW_CAP. Sin esto, un rango con 3000+
        // cancelaciones devolvía exactamente 3000 filas con `partial=false` —
        // truncado silencioso, justo lo que este reporte no puede hacer.
        const { data, error } = await rpc('cancelaciones_analisis', {
          p_store_id: activeStoreId, p_desde: desde, p_hasta: hasta, p_limite: ROW_CAP,
        });
        if (!error) {
          const filas = data ?? [];
          crudas.push(...filas);
          const cabeza = filas[0] as Record<string, unknown> | undefined;
          if (cabeza) {
            totalPeriodo += Number(cabeza.total_periodo ?? 0);
            generados    += Number(cabeza.generados_periodo ?? 0);
          } else {
            denominadorParcial = true;
          }
          return;
        }

        const code = (error as { code?: string }).code;
        const msg = (error as { message?: string }).message || '';
        // Estos NO se reintentan: partir el rango no arregla un permiso ni una
        // función que no existe, solo multiplica el error por cada tramo.
        if (code === '42501' || /no autorizado|sin permiso/i.test(msg)) { fatal = 'forbidden'; return; }
        if (code === 'PGRST202' || /does not exist|could not find|schema cache/i.test(msg)) { fatal = 'not_ready'; return; }

        const esTimeout = code === '57014' || /timeout|canceling statement/i.test(msg);
        const mitades = esTimeout ? partirALaMitad(desde, hasta) : null;
        if (!mitades) {
          // Un solo día que no entra, o un error que no es de tiempo: se anota.
          sinLeer.push(desde === hasta ? desde : `${desde}→${hasta}`);
          return;
        }
        await leerTramo(mitades[0][0], mitades[0][1]);
        await leerTramo(mitades[1][0], mitades[1][1]);
      };

      const tramos = partirRango(fromDate, toDate, DIAS_POR_TRAMO);
      for (let i = 0; i < tramos.length; i += TRAMOS_EN_PARALELO) {
        if (fatal) break;
        await Promise.all(
          tramos.slice(i, i + TRAMOS_EN_PARALELO).map(([a, b]) => leerTramo(a, b)),
        );
        if (seq !== seqRef.current) return;
      }
      if (seq !== seqRef.current) return;
      if (fatal) {
        setStatus(fatal);
        setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false); setDiasSinLeer([]);
        return;
      }
      // Ni una sola fila y encima tramos caídos: no es "no hubo cancelaciones",
      // es que no se pudo leer. Se dice, no se dibuja un cero.
      if (!crudas.length && sinLeer.length) {
        setStatus('error');
        setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false); setDiasSinLeer(sinLeer);
        return;
      }
      const raw = crudas;
      let mapped = raw.map(mapRow);

      // ── Los que NO se perdieron: se rehicieron ──────────────────────────
      // Segunda RPC, ADITIVA: marca los cancelados que volvieron a entrar con
      // otro número en menos de 48 h (mismo cliente, mismo producto). Sin
      // esto, un cambio de transportadora cuenta como venta perdida Y la
      // venta buena entra aparte: la misma plata, dos veces.
      //
      // Va aparte y no dentro de `cancelaciones_analisis` para no reescribir
      // una función viva (⛔ REGLA #1). Si la migración todavía no corrió, el
      // error se ignora y el reporte queda como estaba: es información de
      // más, nunca un bloqueo.
      try {
        const { data: rec, error: recErr } = await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>,
        ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>)(
          'cancelaciones_recreadas',
          { p_store_id: activeStoreId, p_desde: fromDate, p_hasta: toDate, p_limite: ROW_CAP },
        );
        if (!recErr && Array.isArray(rec) && rec.length) {
          const ids = new Set(rec.map(x => String(x.order_id)));
          mapped = mapped.map(r => (ids.has(r.orderId) ? { ...r, recreado: true } : r));
        }
      } catch { /* sin la migración el reporte sigue sirviendo */ }

      // ── Los que nunca usaron el WhatsApp ────────────────────────────────
      // `orders.chat_riesgo` lo llena `importchat-sync`. Le pone nombre a una
      // parte del bucket ciego: en agosto-EC eran 157 pedidos con 66,2% de
      // cancelación y $3.219 —la mitad de todo lo perdido en el mes— que hasta
      // ahora caían en "nadie anotó por qué".
      //
      // Va en una consulta APARTE y no dentro de `cancelaciones_analisis` para
      // no reescribir una función viva (⛔ REGLA #1), y es el mismo camino que
      // ya usa `cancelaciones_recreadas` acá arriba. Si la columna todavía no
      // existe, el error se ignora y el reporte queda como estaba.
      try {
        const ids = mapped.map(r => r.orderId).filter(Boolean);
        // De a 200: los `id` van en la URL y con un rango largo son miles de
        // UUIDs — la petición se pasa del largo máximo y falla ENTERA, así que
        // se perdía la señal de todo el período por culpa del tamaño.
        const LOTE = 200;
        type Fila = { id: string; chat_riesgo: unknown; chat_leido_at: string | null };
        const porId = new Map<string, string>();
        for (let i = 0; i < ids.length; i += LOTE) {
          const { data: ch, error: chErr } = await supabase
            .from('orders')
            .select('id, chat_riesgo, chat_leido_at')
            .eq('store_id', activeStoreId)
            .in('id', ids.slice(i, i + LOTE));
          if (chErr || !Array.isArray(ch)) continue;
          for (const row of ch as unknown as Fila[]) {
            // Sin `chat_leido_at` nadie miró esa conversación: no se afirma nada.
            if (!row.chat_leido_at) continue;
            if (row.chat_riesgo) porId.set(String(row.id), String(row.chat_riesgo));
          }
        }
        if (porId.size) {
          mapped = mapped.map(r => (
            porId.has(r.orderId) ? { ...r, riesgoChat: porId.get(r.orderId)! } : r
          ));
        }
      } catch { /* la señal es información de más, nunca un bloqueo */ }

      setRows(mapped);
      setResumen(summarizeCancelaciones(mapped, {
        // null y no 0: sin denominador la tasa se muestra "—". Un 0 acá haría
        // una división que da infinito o un 100% inventado.
        generados: (denominadorParcial || !crudas.length) ? null : generados,
        totalPeriodo,
      }));
      setPartial(mapped.length >= ROW_CAP);
      setDiasSinLeer(sinLeer);
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) {
        setStatus('error'); setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false); setDiasSinLeer([]);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, fromDate, toDate]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, resumen, rows, partial, diasSinLeer, refresh: () => void load() };
}
