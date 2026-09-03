import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { estadoConversacion } from '@/lib/actividadChat';

/**
 * La bandeja central: TODOS los clientes de la tienda que escribieron y nadie
 * les contestó — cruzando Confirmar y Seguimiento, en una sola lista.
 *
 * Nace de la regla del dueño ("que a todos se les llame/escriba, que nada se
 * enfríe") ahora que la mayoría del tráfico es inbound. Los chips "te escribió"
 * viven dispersos por tarjeta y por columna; con volumen alto hace falta UN lugar
 * que los junte y los ordene por quién lleva más esperando.
 *
 * "Esperando" = el último mensaje del chat es del CLIENTE (estadoConversacion
 * === 'espera_respuesta'). Se calcula con la MISMA función que los chips, para no
 * tener dos definiciones que se desincronicen.
 */

export interface InboxItem {
  dbId: string;
  externalId: string;
  nombre: string;
  phone: string;
  estado: string;
  ciudad: string | null;
  direccion: string | null;
  producto: string | null;
  valor: number | null;
  guia: string | null;
  transportadora: string | null;
  /** ms epoch del último mensaje del cliente (por eso está esperando). */
  entranteAt: number;
  /** ms epoch del último mensaje NUESTRO, y cuándo se leyó la conversación.
   *  Van juntos para poder armar el `ActividadChatOrden` que necesita el botón
   *  de acción: sin ellos, la ventana de 24 h queda en `sin_dato` y el botón se
   *  apaga — justo en la pantalla donde la ventana está abierta con seguridad. */
  salienteAt: number | null;
  leidoAt: number;
  /** Quién lo tiene EN ATENCIÓN ahora mismo, y desde cuándo. Con esto la
   *  bandeja dibuja «En atención por X» y dos personas no le escriben al mismo
   *  cliente a la vez. `null` = libre. */
  lockedBy: string | null;
  lockedAt: string | null;
  /** Días que lleva EN SU ESTADO ACTUAL (desde `last_movement_at`), no desde
   *  que nació el pedido. `null` si Dropi no reporta el movimiento — y `null`
   *  se dibuja "—", nunca 0: no saber cuántos días lleva no es "llegó hoy". */
  diasEnEstado: number | null;
}

/**
 * `sin_medir` NO es lo mismo que `ok` con la lista vacía.
 *
 * ⛔ Visto en producción el 2-sep-2026 con Rushmira (Colombia): la pantalla
 * decía «Nadie esperando respuesta — todos los que escribieron ya fueron
 * atendidos 🎉» mientras 39 clientes esperaban de verdad en Chatea Pro, 22 de
 * ellos hacía más de un día. La tienda tenía CERO pedidos con
 * `chat_entrante_at` (Ecuador tenía 2.196 de 3.426) porque el sync de ese canal
 * todavía no existía. Un cero afirmado sobre un dato que nunca se midió se lee
 * como una buena noticia, y es el peor error que puede cometer esta pantalla.
 */
export type InboxStatus = 'cargando' | 'ok' | 'sin_medir' | 'not_ready' | 'error';

// Estados terminales: un pedido entregado/cancelado no es una mano levantada que
// haya que atender ya. Se filtran client-side (los borrados incluidos).
const TERMINALES = new Set(['ENTREGADO', 'CANCELADO', 'ARCHIVADO GHOST', 'ARCHIVADO_GHOST']);

// Tope de la consulta: se traen las conversaciones con inbound MÁS RECIENTE y se
// filtra a las que esperan. Cubre la ventana de trabajo real; con volumen muy
// alto, una conversación que quedó esperando hace semanas podría caer fuera del
// tope — es una limitación conocida, no un cero silencioso.
const TOPE = 500;

const COLUMNAS =
  'id, external_id, nombre, phone, estado, ciudad, direccion, producto, valor, guia, '
  + 'transportadora, last_movement_at, chat_entrante_at, chat_saliente_at, chat_leido_at, '
  + 'locked_by, locked_at';

type Fila = {
  id: string; external_id: string | null; nombre: string | null; phone: string | null;
  estado: string | null; ciudad: string | null; direccion: string | null; producto: string | null; valor: number | null;
  guia: string | null; transportadora: string | null; last_movement_at: string | null;
  chat_entrante_at: string | null; chat_saliente_at: string | null; chat_leido_at: string | null;
  locked_by: string | null; locked_at: string | null;
};

/**
 * A partir de cuántas horas sin respuesta el mensaje pasa a ser una DEUDA.
 *
 * ── Por qué existe esta segunda canasta (pedido del dueño, 3-sep-2026) ──────
 * Textual: *"tengo un supervisor que manda plantillas con el botón en
 * automático, hace un solo intento y no está pendiente si respondieron"*.
 *
 * Eso hoy es invisible en TODAS las pantallas. El estado ya existía con nombre
 * propio —`estadoConversacion` devuelve `'sin_respuesta'`, *"le escribimos y el
 * cliente nunca contestó nada"*— y se usaba en un solo lugar decorativo: un
 * sufijo de texto en una tarjeta. La bandeja, mientras tanto, mira exactamente
 * lo contrario (quién nos escribió a nosotros).
 *
 * Seis horas y no una: un mensaje mandado a las 11 se reclama a las 17, dentro
 * del mismo turno. Menos convertiría en deuda a cada mensaje recién enviado y
 * la lista se llenaría de trabajo que todavía no lo es — que es como muere una
 * cola de prioridad.
 */
export const HORAS_SIN_RESPUESTA = 6;

/** Más viejo que esto ya no es "falta el 2º intento", es historia. */
const DIAS_VENTANA_SIN_RESPUESTA = 7;

export interface InboxDosColas {
  /** Nos escribieron y nadie contestó. La bandeja de siempre. */
  esperando: InboxItem[];
  /** Les escribimos y no contestaron: falta el 2º intento. */
  sinRespuesta: InboxItem[];
}

/** Lo que la bandeja sabe de una tienda, en un solo objeto. */
interface Snapshot {
  items: InboxItem[];
  sinRespuesta: InboxItem[];
  status: InboxStatus;
  /**
   * ⛔ La SEGUNDA canasta ("les escribimos y no contestaron") falló al leerse.
   * `sinRespuesta` va vacía y NO se puede afirmar nada sobre ella. Hasta el
   * 4-sep-2026 esta bandera no existía: si solo esa consulta fallaba, `status`
   * quedaba 'ok' y la pantalla decía «Nadie quedó sin respuesta 🎉» sobre una
   * cola llena — el incidente de Colombia otra vez, en la misma pantalla.
   */
  deudaError: boolean;
}

// Arranca en 'cargando', NO en 'ok': con 'ok'+vacío la pantalla afirmaría
// "nadie esperando" sobre datos que todavía no llegaron (el bug de la casa).
const VACIO: Snapshot = { items: [], sinRespuesta: [], status: 'cargando', deudaError: false };

/**
 * ⛔ UNA SOLA CONSULTA Y UN SOLO CANAL PARA TODA LA APP (3-sep-2026).
 *
 * Este hook lo montan CUATRO lugares, y varios a la vez: la barra del turno
 * (que vive en todas las rutas), el banner de fin de cola de Confirmar, la
 * bandeja y el panel de Productividad. En `/confirmar` eran DOS instancias
 * simultáneas; cada una abría su propio canal de realtime sobre `orders` y, con
 * cada UPDATE del sync, refrescaba dos consultas de hasta 500 filas.
 *
 * Eso es exactamente el patrón que ya dejó el CRM lento una vez —112 peticiones
 * por minuto con la pantalla quieta, por acumular bucles de realtime— y esta
 * vez lo habría empeorado en la pantalla donde el equipo pasa el día.
 *
 * Con el estado en el módulo, montar el hook diez veces cuesta lo mismo que
 * montarlo una. La cuenta de suscriptores decide cuándo abrir y cerrar el canal.
 */
const SNAPSHOT = new Map<string, Snapshot>();
const SUSCRIPTORES = new Map<string, Set<(s: Snapshot) => void>>();
const CANALES = new Map<string, { ch: ReturnType<typeof supabase.channel>; n: number }>();
/** Corrida en curso por tienda: descarta respuestas viejas que llegan tarde. */
const SECUENCIA = new Map<string, number>();

function publicar(storeId: string, s: Snapshot): void {
  SNAPSHOT.set(storeId, s);
  const subs = SUSCRIPTORES.get(storeId);
  if (subs) for (const f of subs) f(s);
}

async function cargarTienda(storeId: string | null): Promise<void> {
    if (!storeId) return;
    const seq = (SECUENCIA.get(storeId) ?? 0) + 1;
    SECUENCIA.set(storeId, seq);

    // ⛔ DOS CONSULTAS, Y UN SOLO CANAL DE REALTIME PARA TODA LA APP.
    //
    // Un `.or()` no sirve acá: las dos canastas se ordenan por columnas
    // distintas —quién espera hace más, por `chat_entrante_at`; a quién le
    // debemos el 2º intento, por `chat_saliente_at`— y con un solo `order` la
    // segunda mitad caería fuera del tope de 500 sin que nadie se entere. Eso
    // es un cero silencioso, justo lo que esta pantalla vino a corregir.
    //
    // Lo que NO se hace es un hook aparte: esto lo monta también la barra del
    // turno, que vive en TODAS las rutas, y la memoria
    // `crm_lento_cinco_bucles_realtime` mide 112 peticiones/min con la pantalla
    // quieta por acumular bucles. Dos SELECT en paralelo cuestan un viaje; un
    // hook más costaría un canal más, para siempre.
    const [conEntrante, sinEntrante] = await Promise.all([
      supabase
        .from('orders')
        .select(COLUMNAS)
        .eq('store_id', storeId)
        .not('chat_entrante_at', 'is', null)
        .order('chat_entrante_at', { ascending: false })
        .limit(TOPE),
      // Los que NUNCA escribieron: `estadoConversacion` los llama
      // 'sin_respuesta' y no entran en la consulta de arriba por definición.
      supabase
        .from('orders')
        .select(COLUMNAS)
        .eq('store_id', storeId)
        .is('chat_entrante_at', null)
        .not('chat_saliente_at', 'is', null)
        .order('chat_saliente_at', { ascending: false })
        .limit(TOPE),
    ]);
    if (seq !== SECUENCIA.get(storeId)) return;
    const { data, error } = conEntrante;
    if (error) {
      const code = (error as { code?: string }).code;
      const msg = (error as { message?: string }).message || '';
      // 42703 = la migración de columnas de chat no corrió: la función no está
      // prendida todavía, no es un error que avisar.
      publicar(storeId, {
        items: [], sinRespuesta: [], deudaError: true,
        status: code === '42703' || /does not exist|column/i.test(msg) ? 'not_ready' : 'error',
      });
      return;
    }

    const filas = (data ?? []) as unknown as Fila[];
    // ⛔ Si la SEGUNDA consulta falló, la primera canasta se pinta igual (es la
    // de siempre y su dato está completo) pero la segunda va VACÍA y no se
    // afirma nada sobre ella. La pantalla lo dice; no dibuja un cero.
    const filasSinEntrante = sinEntrante.error
      ? []
      : ((sinEntrante.data ?? []) as unknown as Fila[]);

    const ahora = Date.now();
    const umbralMs = HORAS_SIN_RESPUESTA * 3_600_000;
    const pisoMs = ahora - DIAS_VENTANA_SIN_RESPUESTA * 86_400_000;

    const esperandoOut: InboxItem[] = [];
    const deudaOut: InboxItem[] = [];

    const clasificar = (r: Fila) => {
      if (TERMINALES.has((r.estado || '').toUpperCase().trim())) return;
      const entranteAt = r.chat_entrante_at ? Date.parse(r.chat_entrante_at) : null;
      const salienteAt = r.chat_saliente_at ? Date.parse(r.chat_saliente_at) : null;
      const leidoAt = r.chat_leido_at ? Date.parse(r.chat_leido_at) : ahora;
      const estado = estadoConversacion({ salienteAt, salienteTipo: null, entranteAt, leidoAt });

      const item = (): InboxItem => ({
        dbId: String(r.id),
        externalId: r.external_id || '',
        nombre: r.nombre || 'Cliente',
        phone: r.phone || '',
        estado: r.estado || '',
        ciudad: r.ciudad,
        direccion: r.direccion,
        producto: r.producto,
        valor: r.valor != null ? Number(r.valor) : null,
        guia: r.guia,
        transportadora: r.transportadora,
        // `entranteAt` es 0 SOLO en la canasta de deuda, donde el cliente nunca
        // escribió. La pantalla de esa canasta no lo usa (ordena y muestra por
        // `salienteAt`); ponerlo en 0 es preferible a mentir con `Date.now()`,
        // que se leería como "escribió recién".
        entranteAt: entranteAt ?? 0,
        salienteAt,
        leidoAt,
        lockedBy: r.locked_by,
        lockedAt: r.locked_at,
        // floor: 20 h en el mismo estado son 0 días completos, no "1". Misma
        // cuenta que `diasSinMovimiento` en `segPulso`.
        diasEnEstado: r.last_movement_at
          ? Math.max(0, Math.floor((ahora - Date.parse(r.last_movement_at)) / 86_400_000))
          : null,
      });

      if (estado === 'espera_respuesta') { esperandoOut.push(item()); return; }

      // Le escribimos y la última palabra sigue siendo nuestra. Es deuda solo
      // cuando pasó el umbral: un mensaje de hace diez minutos no es un
      // descuido, y meterlo acá llenaría la lista de trabajo que no lo es.
      if (estado === 'conversado' || estado === 'sin_respuesta') {
        if (salienteAt == null) return;
        if (ahora - salienteAt < umbralMs) return;
        if (salienteAt < pisoMs) return;   // más de una semana: ya es historia
        deudaOut.push(item());
      }
    };

    for (const r of filas) clasificar(r);
    for (const r of filasSinEntrante) clasificar(r);

    // Quien lleva MÁS esperando, primero: es a quien más urge no dejar enfriar.
    esperandoOut.sort((a, b) => a.entranteAt - b.entranteAt);
    // Y en la deuda, aquel a quien le escribimos hace más y sigue sin contestar.
    deudaOut.sort((a, b) => (a.salienteAt ?? 0) - (b.salienteAt ?? 0));

    // Ni una sola fila con dato de chat en toda la tienda = nadie lo está
    // midiendo. No se puede afirmar «todos atendidos» sobre eso.
    if (sinEntrante.error) {
      console.warn('[inbox] la canasta "sin respuesta" no se pudo leer:', sinEntrante.error.message);
    }
    publicar(storeId, {
      items: esperandoOut,
      sinRespuesta: deudaOut,
      status: filas.length === 0 && filasSinEntrante.length === 0 ? 'sin_medir' : 'ok',
      deudaError: Boolean(sinEntrante.error),
    });
}

/** Abre el canal de la tienda si es el primero que lo pide. */
function suscribir(storeId: string, avisar: (s: Snapshot) => void): () => void {
  let subs = SUSCRIPTORES.get(storeId);
  if (!subs) { subs = new Set(); SUSCRIPTORES.set(storeId, subs); }
  subs.add(avisar);

  const canal = CANALES.get(storeId);
  if (canal) {
    canal.n += 1;
  } else {
    // Inbound EN VIVO: cuando un cliente escribe (o una asesora responde), la
    // bandeja se re-arma sola. UN canal por tienda, no uno por componente.
    let t: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`inbox-espera-${storeId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `store_id=eq.${storeId}` },
        () => { if (t) clearTimeout(t); t = setTimeout(() => { void cargarTienda(storeId); }, 1500); })
      .subscribe();
    CANALES.set(storeId, { ch, n: 1 });
  }

  // La primera carga la dispara el primero que llega; los demás reciben lo que
  // ya hay y esperan el aviso. Así abrir una segunda pantalla no cuesta nada.
  if (!SNAPSHOT.has(storeId)) void cargarTienda(storeId);

  return () => {
    subs!.delete(avisar);
    const c = CANALES.get(storeId);
    if (!c) return;
    c.n -= 1;
    // El último que se va apaga la luz. Se conserva el snapshot: volver a la
    // pantalla muestra lo último que se supo en vez de un "cargando" en blanco.
    if (c.n <= 0) { CANALES.delete(storeId); void supabase.removeChannel(c.ch); }
  };
}

export function useInboxEsperando(storeId: string | null) {
  const [snap, setSnap] = useState<Snapshot>(
    () => (storeId ? SNAPSHOT.get(storeId) : null) ?? VACIO,
  );

  useEffect(() => {
    if (!storeId) { setSnap(VACIO); return; }
    // Lo que ya se sabía de esta tienda, en el acto: cambiar de pantalla no
    // vuelve a poner la cola en blanco.
    setSnap(SNAPSHOT.get(storeId) ?? VACIO);
    return suscribir(storeId, setSnap);
  }, [storeId]);

  const recargar = useCallback(async () => { await cargarTienda(storeId); }, [storeId]);

  return useMemo(
    () => ({ items: snap.items, sinRespuesta: snap.sinRespuesta, status: snap.status, deudaError: snap.deudaError, recargar }),
    [snap, recargar],
  );
}
