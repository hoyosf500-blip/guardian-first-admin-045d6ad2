import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { normalizarRiesgo, type NivelRiesgo } from '@/lib/riesgoChat';
import type { ActividadChatOrden } from '@/lib/actividadChat';

/**
 * Qué hizo el cliente con el botón de confirmar del WhatsApp, por pedido.
 *
 * Lo escribe la edge function `importchat-sync` en `orders.chat_riesgo`. Acá se
 * lee en UNA sola query (mismo molde que `useOrderNotesIndex`) y se devuelve un
 * Map por `dbId`.
 *
 * ── Por qué va en una query aparte y no en ORDER_COLUMNS ───────────────────
 * Lovable NO auto-aplica migraciones. Si `orderColumns.ts` nombrara una columna
 * que todavía no existe, el SELECT entero devuelve 42703 y se cae **toda**
 * pantalla que cargue pedidos — Confirmar, Seguimiento, Dashboard. Ya pasó y
 * está documentado en CLAUDE.md.
 *
 * Yendo aparte, el peor caso es que esta query falle sola: el estado queda en
 * `not_ready`, la cola sigue ordenándose como siempre y no se dibuja ningún
 * chip. La pantalla no se entera.
 */
export type RiesgoChatStatus = 'ok' | 'not_ready' | 'error';
export type RiesgoIndex = Map<string, NivelRiesgo>;
/** Actividad del chat por pedido (columnas de 20260824230000): último mensaje
 *  del negocio, su tipo, y último del cliente. Solo pedidos con conversación
 *  LEÍDA entran al mapa — sin lectura no se afirma nada. */
export type ActividadIndex = Map<string, ActividadChatOrden>;

const VACIO: RiesgoIndex = new Map();
const VACIO_ACT: ActividadIndex = new Map();

export interface RiesgoChatData {
  index: RiesgoIndex;
  status: RiesgoChatStatus;
  /** Cuántos de los pedidos consultados tienen la conversación ya leída. */
  leidos: number;
  /** ¿Le escribimos? ¿nos escribió? — vacío si la migración nueva no corrió
   *  (el riesgo viejo sigue funcionando igual: fallback en dos fases). */
  actividad: ActividadIndex;
}

export function useRiesgoChat(storeId: string | null, orderIds: string[]): RiesgoChatData {
  const [index, setIndex] = useState<RiesgoIndex>(VACIO);
  const [actividad, setActividad] = useState<ActividadIndex>(VACIO_ACT);
  const [status, setStatus] = useState<RiesgoChatStatus>('ok');
  const seqRef = useRef(0);

  // Firma estable: sin esto, cada refresh de realtime que reconstruye la cola
  // con los MISMOS pedidos dispararía la query de nuevo.
  const idsKey = orderIds.length === 0 ? '' : [...orderIds].sort().join(',');

  const load = useCallback(async () => {
    if (!storeId || !idsKey) { setIndex(VACIO); setActividad(VACIO_ACT); setStatus('ok'); return; }
    const seq = ++seqRef.current;
    const ids = idsKey.split(',');
    // POR LOTES: mismo motivo que useOrderNotesIndex — los ids van en la URL
    // del GET y la cola completa puede pasar de mil pedidos; un solo .in()
    // reventaba la petición entera y la señal del chat desaparecía en silencio.
    const LOTE = 150;
    const lotes: string[][] = [];
    for (let i = 0; i < ids.length; i += LOTE) lotes.push(ids.slice(i, i + LOTE));
    // Dos fases: primero se piden TAMBIÉN las columnas de actividad
    // (20260824230000). Si esa migración no corrió, el select entero daría
    // 42703 y tumbaría de paso el riesgo viejo que YA funciona — por eso el
    // fallback reintenta solo con las columnas originales.
    const pedir = (cols: string) => Promise.all(lotes.map((b) =>
      supabase
        .from('orders')
        .select(cols)
        .eq('store_id', storeId)
        .in('id', b)));
    let conActividad = true;
    let resultados = await pedir('id, chat_riesgo, chat_leido_at, chat_saliente_at, chat_saliente_tipo, chat_entrante_at');
    if (seq !== seqRef.current) return;
    let conError = resultados.find((r) => r.error);
    if (conError && /chat_saliente|chat_entrante/i.test((conError.error as { message?: string })?.message || '')) {
      conActividad = false;
      resultados = await pedir('id, chat_riesgo, chat_leido_at');
      if (seq !== seqRef.current) return;
      conError = resultados.find((r) => r.error);
    }
    const error = conError?.error ?? null;
    const data = error ? null : resultados.flatMap((r) => r.data ?? []);

    if (error) {
      const code = (error as { code?: string }).code;
      const msg = (error as { message?: string }).message || '';
      // 42703 = la migración todavía no corrió. No es un error del que haya que
      // avisar a nadie: es una función que aún no está prendida.
      setStatus(code === '42703' || /does not exist|column/i.test(msg) ? 'not_ready' : 'error');
      setIndex(VACIO);
      setActividad(VACIO_ACT);
      return;
    }

    // `types.ts` se autogenera del esquema y todavía no conoce estas columnas
    // (la migración es nueva). El cast va por `unknown` y NO se toca el archivo
    // generado: regenerarlo a mano es justo lo que después Lovable pisa.
    type Fila = {
      id: string; chat_riesgo: unknown; chat_leido_at: string | null;
      chat_saliente_at?: string | null; chat_saliente_tipo?: string | null; chat_entrante_at?: string | null;
    };
    const filas = (data ?? []) as unknown as Fila[];

    const m: RiesgoIndex = new Map();
    const act: ActividadIndex = new Map();
    for (const row of filas) {
      // Sin `chat_leido_at` nadie miró esa conversación: no se guarda nada, y
      // el pedido queda sin chip. Un chip verde sobre un dato que no existe
      // sería peor que no tener chip.
      if (!row.chat_leido_at) continue;
      const n = normalizarRiesgo(row.chat_riesgo);
      if (n) m.set(String(row.id), n);
      // SIEMPRE se agrega al mapa de actividad si el chat fue leído — aunque la
      // migración de columnas nuevas (20260824230000) no haya corrido. `hayConversacion`
      // se deriva de `actividad.has(orderId)`: si acá se saltara cuando falta esa
      // migración, el chat quedaría INVISIBLE en TODA la app (la card retorna null)
      // hasta que Lovable la aplique. Con `chat_leido_at` ya sabemos que hubo
      // conversación; el detalle (quién escribió último) llega cuando la migración corra.
      act.set(String(row.id), {
        salienteAt: conActividad && row.chat_saliente_at ? Date.parse(row.chat_saliente_at) : null,
        salienteTipo: conActividad && (row.chat_saliente_tipo === 'plantilla' || row.chat_saliente_tipo === 'directo')
          ? row.chat_saliente_tipo : null,
        entranteAt: conActividad && row.chat_entrante_at ? Date.parse(row.chat_entrante_at) : null,
        leidoAt: Date.parse(row.chat_leido_at),
      });
    }
    setIndex(m);
    setActividad(act);
    setStatus('ok');
  }, [storeId, idsKey]);

  useEffect(() => { void load(); }, [load]);

  // ── INBOUND EN VIVO ────────────────────────────────────────────────────────
  // Ahora la mayoría de clientes escriben inbound. Sin esto, cuando un cliente
  // responde por WhatsApp (importchat-sync escribe chat_entrante_at) el chip "te
  // escribió y nadie contestó" y la card NO aparecían hasta que la asesora
  // recargaba o cambiaba la composición de la cola (idsKey es estable a
  // propósito, así que el realtime de la cola no redisparaba esta query).
  //
  // Se suscribe a UPDATE de `orders` por tienda y se recarga —con debounce, para
  // coalescer el lote del sync— solo si el pedido actualizado está en la cola
  // visible. Nombre de canal ÚNICO por instancia del hook: un canal con nombre
  // fijo montado dos veces (Confirmar + Seguimiento) tumba la pantalla.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const idSetRef = useRef<Set<string>>(new Set());
  useEffect(() => { idSetRef.current = new Set(idsKey ? idsKey.split(',') : []); }, [idsKey]);
  // Id POR INSTANCIA (useId): este hook se monta en varias pantallas a la vez
  // (Confirmar, Seguimiento…) y un canal con nombre fijo montado dos veces tumba
  // la pantalla. Vigilado por canalRealtimeUnico.test.ts.
  const instanciaId = useId();
  useEffect(() => {
    if (!storeId) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`riesgo-chat-${instanciaId}-${storeId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `store_id=eq.${storeId}` },
        (payload) => {
          const id = (payload.new as { id?: string })?.id;
          // Solo si es un pedido de la cola visible: evita recargar por cualquier
          // UPDATE de la tienda (el sync toca cientos de filas por corrida).
          if (id && !idSetRef.current.has(id)) return;
          if (t) clearTimeout(t);
          t = setTimeout(() => { void loadRef.current(); }, 1500);
        },
      )
      .subscribe();
    return () => { if (t) clearTimeout(t); void supabase.removeChannel(ch); };
  }, [storeId, instanciaId]);

  return useMemo(
    () => ({ index, status, leidos: index.size, actividad }),
    [index, status, actividad],
  );
}
