import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { rangoDiaBogota, horaDelDiaBogota, horaBogota } from '@/lib/diaBitacora';
import type { MarcaHoraria } from '@/lib/mapaCalor';

/**
 * TODAS las gestiones de UN día, con la hora en que se hicieron.
 *
 * ── Por qué no se reusa lo que ya había ─────────────────────────────────────
 * `useLiveTeam` ya calcula gestiones por hora (`hourly`) y `AdvisorCard` ya las
 * dibuja. Pero lee **las 400 marcas más recientes de TODA la tienda**
 * (`EVENT_SCAN_LIMIT`), y el propio hook lo advierte: *"en un equipo grande las
 * horas más viejas subcontarían"*. Con cinco asesoras a ~120 gestiones ese tope
 * se pasa antes del mediodía, así que **la franja de la mañana —justo la que el
 * dueño quiere controlar— sale corta**. Un mapa de calor construido sobre eso
 * acusaría de no trabajar a quien sí trabajó.
 *
 * Acá se pagina hasta agotar el día. Un día son cientos de filas, no decenas de
 * miles: el tope existía para "hallar la última señal de cada persona", que
 * necesita filas recientes, no el día entero.
 *
 * ── La hora es la de la GESTIÓN, nunca la del pedido ────────────────────────
 * ⛔ `orders.created_at` es cuándo el cron insertó el pedido, corrido +5 h de
 * mediana (`docs/ARQUITECTURA.md`), y ya produjo una conclusión falsa que hubo
 * que retractar. Acá se usa el `created_at` de `touchpoints` / `order_results`,
 * que es cuándo la persona actuó.
 */

/** Una gestión suelta, para poder abrir el detalle de una celda. */
export interface GestionDelDia {
  operatorId: string;
  /** Hora Bogotá 0-23. */
  hora: number;
  /** `14:53`, para la lista del detalle. */
  reloj: string;
  /** De dónde salió: la cola de llamadas o el resto del CRM. */
  fuente: 'confirmar' | 'gestion';
  /** Qué se hizo, en el idioma de la botonera. */
  accion: string;
  phone: string;
}

export type EstadoMapa = 'cargando' | 'ok' | 'not_ready' | 'error';

/** Tope de seguridad por fuente. Un día normal no lo roza; existe para que un
 *  rango mal armado no arrastre la base entera al navegador. */
const TOPE_FILAS = 20_000;
const PAGINA = 1_000;

/** Lee una tabla del día entera, por páginas. */
async function leerTodo(
  tabla: 'touchpoints' | 'order_results',
  columnas: string,
  storeId: string,
  desdeIso: string,
  hastaIso: string,
): Promise<{ filas: Record<string, unknown>[]; error: { code?: string; message?: string } | null }> {
  const filas: Record<string, unknown>[] = [];
  for (let desde = 0; desde < TOPE_FILAS; desde += PAGINA) {
    const { data, error } = await supabase
      .from(tabla)
      .select(columnas)
      .eq('store_id', storeId)
      .gte('created_at', desdeIso)
      .lt('created_at', hastaIso)
      .order('created_at', { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) return { filas, error: error as { code?: string; message?: string } };
    const lote = (data ?? []) as unknown as Record<string, unknown>[];
    filas.push(...lote);
    if (lote.length < PAGINA) break;
  }
  return { filas, error: null };
}

export function useMapaCalorDia(storeId: string | null, ymd: string | null) {
  const [gestiones, setGestiones] = useState<GestionDelDia[]>([]);
  const [estado, setEstado] = useState<EstadoMapa>('cargando');
  const seqRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!storeId || !ymd) { setGestiones([]); setEstado('cargando'); return; }
    const rango = rangoDiaBogota(ymd);
    if (!rango) { setGestiones([]); setEstado('error'); return; }
    const seq = ++seqRef.current;
    setEstado('cargando');

    const [tps, res] = await Promise.all([
      leerTodo('touchpoints', 'operator_id, created_at, action, phone', storeId, rango.desdeIso, rango.hastaIso),
      leerTodo('order_results', 'operator_id, created_at, result, module, phone', storeId, rango.desdeIso, rango.hastaIso),
    ]);
    if (seq !== seqRef.current) return;

    // ⛔ Si CUALQUIERA de las dos falló, no se pinta media verdad. Un mapa con
    // solo la mitad de las fuentes deja horas en cero que sí tuvieron trabajo —
    // y sobre esas celdas el dueño le reclama a una persona.
    const err = tps.error || res.error;
    if (err) {
      const code = err.code;
      const msg = err.message || '';
      setGestiones([]);
      setEstado(code === '42703' || /does not exist|column/i.test(msg) ? 'not_ready' : 'error');
      return;
    }

    const out: GestionDelDia[] = [];
    for (const r of tps.filas) {
      const op = typeof r.operator_id === 'string' ? r.operator_id : null;
      const iso = typeof r.created_at === 'string' ? r.created_at : null;
      const hora = horaDelDiaBogota(iso);
      // Sin persona o sin hora legible la fila se descarta: inventar cualquiera
      // de las dos mueve una gestión de dueño o de franja.
      if (!op || hora == null || !iso) continue;
      out.push({
        operatorId: op,
        hora,
        reloj: horaBogota(iso),
        fuente: 'gestion',
        accion: typeof r.action === 'string' && r.action ? r.action : 'Gestión',
        phone: typeof r.phone === 'string' ? r.phone : '',
      });
    }
    for (const r of res.filas) {
      const op = typeof r.operator_id === 'string' ? r.operator_id : null;
      const iso = typeof r.created_at === 'string' ? r.created_at : null;
      const hora = horaDelDiaBogota(iso);
      if (!op || hora == null || !iso) continue;
      const modulo = typeof r.module === 'string' ? r.module : '';
      const result = typeof r.result === 'string' ? r.result : '';
      out.push({
        operatorId: op,
        hora,
        reloj: horaBogota(iso),
        fuente: 'confirmar',
        accion: [modulo, result].filter(Boolean).join(': ') || 'Resultado',
        phone: typeof r.phone === 'string' ? r.phone : '',
      });
    }
    out.sort((a, b) => a.reloj.localeCompare(b.reloj));
    setGestiones(out);
    setEstado('ok');
  }, [storeId, ymd]);

  useEffect(() => { void cargar(); }, [cargar]);

  /** Lo que come `construirMapaCalor`. */
  const marcas = useMemo<MarcaHoraria[]>(
    () => gestiones.map((g) => ({ operatorId: g.operatorId, hora: g.hora })),
    [gestiones],
  );

  return useMemo(
    () => ({ gestiones, marcas, estado, recargar: cargar }),
    [gestiones, marcas, estado, cargar],
  );
}
