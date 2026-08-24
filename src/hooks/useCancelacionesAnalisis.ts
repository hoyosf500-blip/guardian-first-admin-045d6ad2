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

/**
 * Tramos que se leen SIN preguntar (≈ 40 días, que cubre "el mes pasado").
 *
 * Medido el 23-ago-2026: cada lote de dos tramos tarda ~3 s, así que 365d son
 * 73 consultas ≈ 2 minutos y "Histórico" 62 ≈ 1,5 min. Antes del troceo esos
 * rangos fallaban rápido; con tramos se ponen a moler la base durante minutos
 * MIENTRAS las asesoras trabajan, y la pantalla parece colgada. Pasado este
 * tope no se dispara solo: se dice cuánto va a tardar y decide la persona.
 */
const MAX_TRAMOS_AUTO = 8;

/** Segundos estimados para N tramos (~3 s por lote de dos, medido). */
export function segundosEstimados(tramos: number): number {
  return Math.ceil(tramos / TRAMOS_EN_PARALELO) * 3;
}

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
  /**
   * Avance de la lectura por tramos, para poder decir "voy por 3 de 5" en vez
   * de dejar la pantalla muda 12 segundos.
   */
  progreso: { listos: number; total: number };
  /**
   * Rango demasiado ancho para leerlo solo. No es un error ni un vacío: es una
   * decisión que se le devuelve a la persona, con el costo en la mano.
   */
  rangoAncho: { tramos: number; segundos: number } | null;
  /** Leer igual el rango ancho (lo dispara el botón de la pantalla). */
  leerIgual: () => void;
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
  // true INICIAL: la carga vive en un useEffect (corre DESPUÉS del paint) — con
  // false, el primer frame tenía loading=false + 0 cancelados y la pantalla
  // alcanzaba a afirmar "No hubo cancelaciones. Es un buen resultado" sobre
  // datos que nadie pidió todavía (versión residual del bug del 23-ago).
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<CancelacionesStatus>('ok');
  const [resumen, setResumen] = useState<CancelacionesResumen>(EMPTY_RESUMEN);
  const [rows, setRows] = useState<CancelacionRow[]>([]);
  const [partial, setPartial] = useState(false);
  const [diasSinLeer, setDiasSinLeer] = useState<string[]>([]);
  const [progreso, setProgreso] = useState({ listos: 0, total: 0 });
  const [rangoAncho, setRangoAncho] = useState<{ tramos: number; segundos: number } | null>(null);
  // Clave del rango que la persona autorizó leer entero. Cambiar de fechas la
  // invalida sola: autorizar un rango no autoriza el siguiente.
  const [forzado, setForzado] = useState<string | null>(null);
  const seqRef = useRef(0);

  const { fromDate, toDate } = filtros;

  const load = useCallback(async () => {
    // Sin tienda activa (primer render) no se consulta: null significa
    // "todavía no sé cuál", no "todas".
    if (!activeStoreId || !fromDate || !toDate) {
      // setLoading(false): con el inicial en true, sin este release un usuario
      // sin tienda quedaría en "cargando" eterno.
      setResumen(EMPTY_RESUMEN); setRows([]); setStatus('ok'); setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      // ⛔ `.bind(supabase)` NO ES OPCIONAL. El cast es solo de tipos y no
      // conserva el receptor: guardar `supabase.rpc` en una constante deja
      // `this` en undefined y supabase-js tira "Cannot read properties of
      // undefined (reading 'rest')". La invocación directa
      // `(supabase.rpc as X)(...)` sí lo conserva — la diferencia está en
      // guardarlo, no en el cast. Ya costó caro tres veces.
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;

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
      // Truncado: se mira POR TRAMO. `mapped.length >= ROW_CAP` comparaba el
      // TOTAL sumado contra el tope de UNA consulta, así que 8 tramos de 700
      // filas (ninguno truncado) gritaban "faltan datos" sin faltar ninguno.
      let truncadoAlgunTramo = false;

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
          if (filas.length >= ROW_CAP) truncadoAlgunTramo = true;
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
          // Y el universo queda incompleto: de este tramo se perdieron TANTO las
          // cancelaciones como los generados. Sin esta marca la tasa se seguía
          // imprimiendo con los dos lados cortos — un porcentaje que no es el
          // del rango que la persona pidió, y sin nada que lo dijera. El aviso
          // de "días sin leer" avisa que falta DETALLE, no que la tasa mienta.
          denominadorParcial = true;
          return;
        }
        await leerTramo(mitades[0][0], mitades[0][1]);
        await leerTramo(mitades[1][0], mitades[1][1]);
      };

      const tramos = partirRango(fromDate, toDate, DIAS_POR_TRAMO);
      if (tramos.length > MAX_TRAMOS_AUTO && forzado !== `${fromDate}|${toDate}`) {
        setRangoAncho({ tramos: tramos.length, segundos: segundosEstimados(tramos.length) });
        setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false); setDiasSinLeer([]);
        setStatus('ok');
        return;
      }
      setRangoAncho(null);
      // Se BLANQUEA el reporte anterior antes de leer. Sin esto, al cambiar el
      // rango la pantalla mostraba el reporte COMPLETO del rango viejo (motivos,
      // operadoras, hasta su banner de "días sin leer") bajo el encabezado de
      // las fechas nuevas durante los ~10-12 s del troceo — y el aviso
      // "Leyendo el período…" nunca aparecía, porque su gate es
      // `totalCancelados === 0` y con datos viejos nunca lo es. Es el espejo
      // exacto del bug "No hubo cancelaciones mientras cargaba": en vez de
      // afirmar un cero falso, afirmaba el dato de OTRO período. Costo
      // aceptado: "Recargar" sobre el mismo rango también blanquea — mejor
      // decir "leyendo" que sostener un dato que quizá ya no es.
      setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false); setDiasSinLeer([]);
      setProgreso({ listos: 0, total: tramos.length });

      // ── El universo del período, aparte y de una sola vez ───────────────
      // Dos COUNT agregados sobre `orders` por el rango COMPLETO: no lleva las
      // subconsultas por pedido que hacen lenta a `cancelaciones_analisis`, así
      // que no hay que trocearlo. Se dispara ACÁ para que corra en paralelo con
      // los tramos y no sume espera.
      //
      // Es lo que hace que la TASA no dependa de que el troceo salga completo.
      // Sumando por tramos, un tramo vacío (5 días sin cancelar) o uno caído
      // dejaba el denominador corto; ahora el detalle puede venir incompleto —
      // y se avisa — mientras el porcentaje de arriba sigue siendo el del rango
      // que la persona pidió.
      //
      // ADITIVA: si la migración 20260823120000 no está aplicada, esto falla,
      // se ignora, y se cae a la suma por tramos de siempre.
      const universoPromise = (async (): Promise<{ generados: number; cancelados: number } | null> => {
        try {
          const { data, error } = await rpc('cancelaciones_universo', {
            p_store_id: activeStoreId, p_desde: fromDate, p_hasta: toDate,
          });
          if (error) return null;
          const fila = (data ?? [])[0] as Record<string, unknown> | undefined;
          if (!fila) return null;
          const g = Number(fila.generados ?? NaN);
          const c = Number(fila.cancelados ?? NaN);
          if (!isFinite(g) || !isFinite(c)) return null;
          return { generados: g, cancelados: c };
        } catch { return null; }
      })();
      for (let i = 0; i < tramos.length; i += TRAMOS_EN_PARALELO) {
        if (fatal) break;
        const lote = tramos.slice(i, i + TRAMOS_EN_PARALELO);
        await Promise.all(lote.map(([a, b]) => leerTramo(a, b)));
        if (seq !== seqRef.current) return;
        setProgreso(p => ({ listos: Math.min(p.listos + lote.length, tramos.length), total: tramos.length }));
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
        type Fila = {
          id: string; chat_riesgo: unknown; chat_leido_at: string | null;
          chat_saliente_at?: string | null; chat_saliente_tipo?: string | null;
        };
        const porId = new Map<string, string>();
        // ¿Se le ESCRIBIÓ antes de perderlo? (columnas 20260824230000). Se
        // guarda aparte del riesgo: leído + sin saliente = "nadie le escribió
        // jamás", que es la respuesta directa a "¿a los cancelados ya se les
        // escribió?". Fallback en dos fases: si la migración nueva no corrió,
        // se repite el lote solo con las columnas viejas para no perder
        // TAMBIÉN el riesgo, que ya funciona.
        const salientePorId = new Map<string, { at: string | null; tipo: string | null }>();
        let conActividad = true;
        for (let i = 0; i < ids.length; i += LOTE) {
          const lote = ids.slice(i, i + LOTE);
          // El cast por `unknown` es el mismo de useRiesgoChat: types.ts se
          // autogenera y no conoce las columnas nuevas; con el select dinámico
          // el typegen de supabase-js además infiere un ParserError inservible.
          const consulta = (cols: string) => supabase
            .from('orders')
            .select(cols)
            .eq('store_id', activeStoreId)
            .in('id', lote) as unknown as Promise<{ data: unknown; error: { message?: string } | null }>;
          let { data: ch, error: chErr } = await consulta(conActividad
            ? 'id, chat_riesgo, chat_leido_at, chat_saliente_at, chat_saliente_tipo'
            : 'id, chat_riesgo, chat_leido_at');
          if (chErr && conActividad && /chat_saliente/i.test(chErr.message || '')) {
            conActividad = false;
            ({ data: ch, error: chErr } = await consulta('id, chat_riesgo, chat_leido_at'));
          }
          if (chErr || !Array.isArray(ch)) continue;
          for (const row of ch as unknown as Fila[]) {
            // Sin `chat_leido_at` nadie miró esa conversación: no se afirma nada.
            if (!row.chat_leido_at) continue;
            if (row.chat_riesgo) porId.set(String(row.id), String(row.chat_riesgo));
            if (conActividad) {
              salientePorId.set(String(row.id), {
                at: row.chat_saliente_at ?? null,
                tipo: row.chat_saliente_tipo ?? null,
              });
            }
          }
        }
        if (porId.size || salientePorId.size) {
          mapped = mapped.map(r => {
            const sal = salientePorId.get(r.orderId);
            const extra: Record<string, unknown> = {};
            if (porId.has(r.orderId)) extra.riesgoChat = porId.get(r.orderId)!;
            if (sal) { extra.chatSalienteAt = sal.at; extra.chatSalienteTipo = sal.tipo; extra.chatLeido = true; }
            return Object.keys(extra).length ? { ...r, ...extra } : r;
          });
        }
      } catch { /* la señal es información de más, nunca un bloqueo */ }

      // El universo manda sobre la suma por tramos cuando está disponible: es
      // el rango entero medido de una, sin depender de qué tramo salió bien.
      const universo = await universoPromise;
      if (seq !== seqRef.current) return;

      setRows(mapped);
      setResumen(summarizeCancelaciones(mapped, {
        // null y no 0: sin denominador la tasa se muestra "—". Un 0 acá haría
        // una división que da infinito o un 100% inventado.
        generados: universo
          ? universo.generados
          : (denominadorParcial || !crudas.length) ? null : generados,
        totalPeriodo: universo ? universo.cancelados : totalPeriodo,
      }));
      setPartial(truncadoAlgunTramo);
      setDiasSinLeer(sinLeer);
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) {
        setStatus('error'); setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false); setDiasSinLeer([]);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, fromDate, toDate, forzado]);

  useEffect(() => { void load(); }, [load]);

  return {
    loading, status, resumen, rows, partial, diasSinLeer, progreso, rangoAncho,
    leerIgual: () => setForzado(`${fromDate}|${toDate}`),
    refresh: () => void load(),
  };
}
