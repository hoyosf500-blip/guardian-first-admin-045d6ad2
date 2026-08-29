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

/** Los ids van en la URL del GET: por lotes, o la petición revienta entera. */
const LOTE = 150;
const COLS_CON_ACTIVIDAD =
  'id, chat_riesgo, chat_leido_at, chat_saliente_at, chat_saliente_tipo, chat_entrante_at';
const COLS_BASE = 'id, chat_riesgo, chat_leido_at';

/**
 * Piso entre recargas por realtime. Ver el comentario del efecto de abajo: el
 * sync de Dropi y el de ImporChat escriben en `orders` sin parar, y CADA
 * escritura pedía el estado de chat de la cola COMPLETA en 5 lotes de 150.
 */
const PISO_REFRESCO_MS = 8_000;

/**
 * ⛔ PISO ANTES DE LA PRIMERA CARGA (medido en producción, 29-ago-2026).
 *
 * La cola visible se arma de dos fuentes que aterrizan casi juntas: los pedidos
 * (`useDataLoader`) y el índice de cierres (`useSegTouchIndex`, que los filtra).
 * Cada aterrizaje cambia `idsKey` y disparaba una carga entera. Medido con el
 * cronómetro:
 *
 *   t=6344  tanda A → 5 lotes, 661 pedidos, ~1.000 ms cada uno
 *   t=6346  tanda B → 4 lotes, 582 pedidos   ← 2 ms después
 *
 * `seqRef` descarta bien el resultado de A, pero **las cinco peticiones ya
 * salieron**: son ~1.000 ms de trabajo tirado y, peor, duplican la carga
 * concurrente justo en el instante en que la pantalla intenta asentarse (nueve
 * consultas pesadas a la vez se estorban entre ellas y las nueve tardan más).
 *
 * Antes iban separadas 2,4 s y el desperdicio pasaba desapercibido; al acelerar
 * lo de arriba quedaron una encima de la otra y se hizo visible.
 *
 * Es un PISO, no un debounce que se reinicia — la misma regla que el refresco de
 * realtime de más abajo: bajo un chorro de cambios, un debounce que se reinicia
 * puede no disparar NUNCA y dejar la pantalla sin señal de chat. Acá el timer se
 * arma una vez y, cuando vence, usa el `load` MÁS NUEVO.
 */
const PISO_PRIMERA_CARGA_MS = 250;

/**
 * A partir de cuántos pedidos vale la pena esperar.
 *
 * ⛔ Este hook NO es solo de la cola: `CallView`, `CrmCallView` y
 * `ChatClienteCard` lo llaman con UN id para el pedido abierto. Ahí el piso
 * sería una regresión donde más se nota —el dueño vive en el pedido abierto— y
 * además no arregla nada: con un id no hay dos tandas que juntar. Una consulta
 * chica sale al instante; el piso es para la ráfaga de la cola.
 */
const MINIMO_PARA_ESPERAR = LOTE;

type Fila = {
  id: string; chat_riesgo: unknown; chat_leido_at: string | null;
  chat_saliente_at?: string | null; chat_saliente_tipo?: string | null; chat_entrante_at?: string | null;
};

/** Una fila → su entrada de actividad. `conActividad` es false cuando la
 *  migración de columnas nuevas todavía no corrió. */
function aActividad(row: Fila, conActividad: boolean): ActividadChatOrden {
  return {
    salienteAt: conActividad && row.chat_saliente_at ? Date.parse(row.chat_saliente_at) : null,
    salienteTipo: conActividad && (row.chat_saliente_tipo === 'plantilla' || row.chat_saliente_tipo === 'directo')
      ? row.chat_saliente_tipo : null,
    entranteAt: conActividad && row.chat_entrante_at ? Date.parse(row.chat_entrante_at) : null,
    leidoAt: Date.parse(row.chat_leido_at as string),
  };
}

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
  /** ¿La migración de columnas de actividad ya corrió? Lo decide la carga
   *  completa; el refresco dirigido reusa la respuesta en vez de volver a
   *  descubrirlo (y de arriesgar un 42703 que tumbe el riesgo que ya anda). */
  const conActividadRef = useRef(true);

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
    let resultados = await pedir(COLS_CON_ACTIVIDAD);
    if (seq !== seqRef.current) return;
    let conError = resultados.find((r) => r.error);
    if (conError && /chat_saliente|chat_entrante/i.test((conError.error as { message?: string })?.message || '')) {
      conActividad = false;
      resultados = await pedir(COLS_BASE);
      if (seq !== seqRef.current) return;
      conError = resultados.find((r) => r.error);
    }
    conActividadRef.current = conActividad;
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
      act.set(String(row.id), aActividad(row, conActividad));
    }
    setIndex(m);
    setActividad(act);
    setStatus('ok');
  }, [storeId, idsKey]);

  // Ver `PISO_PRIMERA_CARGA_MS`: dos cambios de cola separados por milisegundos
  // salían como DOS cargas completas y la primera se tiraba entera.
  const loadRef = useRef(load);
  loadRef.current = load;
  const pisoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Sin tienda o sin cola no hay nada que pedir: se vacía YA, sin esperar.
    if (!storeId || !idsKey) {
      if (pisoRef.current) { clearTimeout(pisoRef.current); pisoRef.current = null; }
      setIndex(VACIO); setActividad(VACIO_ACT); setStatus('ok');
      return;
    }
    // Una consulta chica (el pedido abierto) sale YA: ver MINIMO_PARA_ESPERAR.
    if (orderIds.length < MINIMO_PARA_ESPERAR) { void load(); return; }
    // Piso: si ya hay uno armado se deja correr. Los cambios que lleguen
    // mientras tanto NO lo reinician — cuando venza, `loadRef` ya apunta a la
    // versión con la cola más nueva, así que sale UN solo viaje con lo último.
    if (pisoRef.current) return;
    pisoRef.current = setTimeout(() => {
      pisoRef.current = null;
      void loadRef.current();
    }, PISO_PRIMERA_CARGA_MS);
    // `load` NO va en las dependencias a propósito: es la MISMA función que
    // `idsKey`/`storeId` ya representan, y agregarla haría que el efecto se
    // reejecute por identidad y rearme el piso. `loadRef` la mantiene fresca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, idsKey]);
  // Al desmontar no queda un timer suelto pidiendo datos de una pantalla que ya
  // no está (ni de la tienda anterior tras un cambio de tienda).
  useEffect(() => () => {
    if (pisoRef.current) { clearTimeout(pisoRef.current); pisoRef.current = null; }
  }, []);

  // ── INBOUND EN VIVO ────────────────────────────────────────────────────────
  // Ahora la mayoría de clientes escriben inbound. Sin esto, cuando un cliente
  // responde por WhatsApp (importchat-sync escribe chat_entrante_at) el chip "te
  // escribió y nadie contestó" y la card NO aparecían hasta que la asesora
  // recargaba o cambiaba la composición de la cola (idsKey es estable a
  // propósito, así que el realtime de la cola no redisparaba esta query).
  //
  // Se suscribe a UPDATE de `orders` por tienda y refresca SOLO los pedidos que
  // cambiaron, con un piso de tiempo entre refrescos.
  //
  // ── Por qué dejó de recargar todo (medido en producción, 28-ago-2026) ───────
  // Antes, cualquier UPDATE de un pedido visible pedía el estado de chat de la
  // cola COMPLETA: 605 pedidos en 5 lotes de 150. Con el tablero abierto y NADIE
  // tocando nada, eso salía dos veces en cuatro segundos (10 peticiones), porque
  // el sync escribe en `orders` sin parar. Peor: LEER una conversación estampa
  // `chat_leido_at`, o sea que abrir un chat se disparaba a sí mismo la recarga
  // de los 605 — medido, 3 s después de abrirlo.
  //
  // Dos cambios, los dos necesarios:
  //  1. **Dirigido**: se piden solo los ids tocados y se FUNDEN sobre los mapas
  //     que ya están en memoria. Fundir, no reemplazar: una respuesta parcial que
  //     pisara el mapa entero borraría el chip de todos los demás pedidos.
  //  2. **Piso de tiempo, no debounce que se reinicia**: bajo un chorro continuo
  //     de eventos, un debounce que se reinicia dispara en los huecos al azar y
  //     nunca se calma. Un piso agrupa la ráfaga en UNA sola llamada y garantiza
  //     que no haya más de una cada PISO_REFRESCO_MS.
  //
  // Nombre de canal ÚNICO por instancia del hook: un canal con nombre fijo
  // montado dos veces (Confirmar + Seguimiento) tumba la pantalla.
  const idSetRef = useRef<Set<string>>(new Set());
  useEffect(() => { idSetRef.current = new Set(idsKey ? idsKey.split(',') : []); }, [idsKey]);

  /**
   * Trae SOLO esos pedidos y los funde sobre lo que ya hay.
   *
   * Si algo falla no se toca nada: se conserva lo último que sí se pudo leer, en
   * vez de vaciar los chips por un error de red. Y si ninguna fila cambió se
   * devuelven los MISMOS Map: sin eso, cada refresco cambiaría la identidad del
   * mapa y redibujaría el tablero entero de la asesora.
   */
  const fusionar = useCallback(async (idsTocados: string[]) => {
    if (!storeId || idsTocados.length === 0) return;
    const lotes: string[][] = [];
    for (let i = 0; i < idsTocados.length; i += LOTE) lotes.push(idsTocados.slice(i, i + LOTE));
    const cols = conActividadRef.current ? COLS_CON_ACTIVIDAD : COLS_BASE;
    const res = await Promise.all(lotes.map((b) =>
      supabase.from('orders').select(cols).eq('store_id', storeId).in('id', b)));
    if (res.some((r) => r.error)) return;
    const filas = res.flatMap((r) => r.data ?? []) as unknown as Fila[];
    if (filas.length === 0) return;
    const conAct = conActividadRef.current;

    setIndex((prev) => {
      let cambio = false;
      const m = new Map(prev);
      for (const row of filas) {
        const id = String(row.id);
        const n = row.chat_leido_at ? normalizarRiesgo(row.chat_riesgo) : null;
        if (n) { if (m.get(id) !== n) { m.set(id, n); cambio = true; } }
        else if (m.delete(id)) cambio = true;
      }
      return cambio ? m : prev;
    });

    setActividad((prev) => {
      let cambio = false;
      const m = new Map(prev);
      for (const row of filas) {
        const id = String(row.id);
        if (!row.chat_leido_at) { if (m.delete(id)) cambio = true; continue; }
        const nueva = aActividad(row, conAct);
        const vieja = m.get(id);
        if (!vieja || vieja.salienteAt !== nueva.salienteAt || vieja.entranteAt !== nueva.entranteAt
          || vieja.salienteTipo !== nueva.salienteTipo || vieja.leidoAt !== nueva.leidoAt) {
          m.set(id, nueva); cambio = true;
        }
      }
      return cambio ? m : prev;
    });
  }, [storeId]);
  const fusionarRef = useRef(fusionar);
  useEffect(() => { fusionarRef.current = fusionar; }, [fusionar]);
  // Id POR INSTANCIA (useId): este hook se monta en varias pantallas a la vez
  // (Confirmar, Seguimiento…) y un canal con nombre fijo montado dos veces tumba
  // la pantalla. Vigilado por canalRealtimeUnico.test.ts.
  const instanciaId = useId();
  useEffect(() => {
    if (!storeId) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    let ultimo = 0;
    const pendientes = new Set<string>();
    const agendar = () => {
      // Piso, NO debounce: si ya hay uno armado se deja correr; los ids que
      // sigan llegando se suben al mismo viaje.
      if (t) return;
      const espera = Math.max(0, PISO_REFRESCO_MS - (Date.now() - ultimo));
      t = setTimeout(() => {
        t = null;
        ultimo = Date.now();
        const ids = [...pendientes];
        pendientes.clear();
        if (ids.length) void fusionarRef.current(ids);
      }, espera);
    };
    const ch = supabase
      .channel(`riesgo-chat-${instanciaId}-${storeId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `store_id=eq.${storeId}` },
        (payload) => {
          const id = (payload.new as { id?: string })?.id;
          // Solo si es un pedido de la cola visible: evita refrescar por cualquier
          // UPDATE de la tienda (el sync toca cientos de filas por corrida).
          if (!id || !idSetRef.current.has(id)) return;
          pendientes.add(id);
          agendar();
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
