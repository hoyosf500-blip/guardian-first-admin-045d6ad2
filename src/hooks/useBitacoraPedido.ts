import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { soloObserva } from '@/lib/rolesTrabajo';
import {
  INTERVALO_MS,
  TOPE_LOTE,
  msEnPantalla,
  esSalto,
  type EventoPedido,
  type EventoPendiente,
  type DetalleEvento,
} from '@/lib/eventosPedido';

/**
 * Escribir en la bitácora sin que la asesora lo note.
 *
 * ── Las reglas que NO se negocian ───────────────────────────────────────────
 *
 * 1. **Nada de esto puede romper ni frenar la pantalla.** Los eventos se juntan
 *    en una cola de módulo y se mandan en lote cada {@link INTERVALO_MS}. Un
 *    error se traga con `console.warn`: una asesora no puede perder una gestión
 *    porque la bitácora tuvo un mal minuto.
 *
 * 2. **La cola es de MÓDULO, no del componente.** Si viviera dentro del hook,
 *    cada tarjeta montada tendría la suya y su propio reloj — cuarenta timers
 *    y cuarenta viajes. Es el mismo error que produjo las 112 peticiones por
 *    minuto con la pantalla quieta (ver `crm_lento_cinco_bucles_realtime`).
 *
 * 3. ⛔ **No es a prueba de balas y no se promete que lo sea.** Si el navegador
 *    se cierra de golpe se pierde el último lote. Se vacía la cola cuando la
 *    pestaña se oculta —que es lo que dispara el cierre normal— pero una
 *    ausencia en la bitácora NO prueba que algo no pasó.
 */

const COLA: EventoPendiente[] = [];
let reloj: ReturnType<typeof setInterval> | null = null;
let suscriptores = 0;

/**
 * Gestiones registradas sobre cada pedido mientras está a la vista, contadas
 * ENTRE instancias del hook (4-sep-2026). `marco` lo emite OrderContext,
 * `gestiono`/`llamo`/`escribio` los emite useRecordGestion, y el `abrio`/`cerro`
 * lo lleva `usePedidoALaVista` en la pantalla: tres instancias distintas. Sin
 * este contador compartido, la pantalla tenía que acordarse de llamar a
 * `marcarGestion()` en cada botón —y donde se olvidaba, una asesora que
 * confirmó 30 pedidos figuraba con 30 "saltos".
 */
const GESTIONES_EN_VIVO = new Map<string, number>();
const EVENTOS_GESTION: ReadonlySet<EventoPedido> = new Set<EventoPedido>(['gestiono', 'llamo', 'escribio', 'marco', 'edito']);

async function vaciar(): Promise<void> {
  if (COLA.length === 0) return;
  // Se saca TODO antes del viaje: si mientras tanto llegan eventos nuevos, van
  // al lote siguiente en vez de mandarse dos veces.
  const lote = COLA.splice(0, COLA.length);
  const { error } = await supabase.from('order_events').insert(lote);
  if (error) {
    // ⛔ NO se reencolan. Un lote que la base rechaza —RLS, una columna que no
    // existe porque la migración todavía no corrió— volvería a fallar para
    // siempre, creciendo sin techo hasta comerse la memoria de la pestaña. Se
    // pierde ese lote y se avisa por consola; la bitácora es un extra, no puede
    // convertirse en el problema.
    console.warn('[bitácora] no se pudo guardar un lote de', lote.length, 'eventos:', error.message);
  }
}

function arrancarReloj(): void {
  if (reloj) return;
  reloj = setInterval(() => { void vaciar(); }, INTERVALO_MS);
}

function pararReloj(): void {
  if (!reloj) return;
  clearInterval(reloj);
  reloj = null;
}

/** La pestaña se oculta = casi siempre, la persona se va. Último intento. */
function alOcultarse(): void {
  if (document.visibilityState === 'hidden') void vaciar();
}

export interface RegistrarOpciones {
  externalId?: string | null;
  phone?: string | null;
  detalle?: DetalleEvento;
  msEnPantalla?: number | null;
}

/**
 * Devuelve `registrar(evento, opciones)`.
 *
 * Sin sesión o sin tienda activa no escribe nada y no se queja: es el estado
 * normal del primer render, no un error.
 */
export function useBitacoraPedido() {
  const { user, isAdmin } = useAuth();
  const { activeStoreId, isOwnerOfActive } = useStore();
  // El dueno MIRA, no trabaja: abrir un pedido no puede tener NINGUN efecto.
  const observa = soloObserva({ isAdmin, isOwnerOfActive });

  useEffect(() => {
    suscriptores += 1;
    arrancarReloj();
    document.addEventListener('visibilitychange', alOcultarse);
    return () => {
      suscriptores -= 1;
      document.removeEventListener('visibilitychange', alOcultarse);
      // El último que se va apaga la luz — y manda lo que quede pendiente.
      if (suscriptores <= 0) { pararReloj(); void vaciar(); }
    };
  }, []);

  return useCallback(
    (evento: EventoPedido, opts: RegistrarOpciones = {}): void => {
      if (!user || !activeStoreId) return;
      // ⛔ AL DUENO NO SE LE ANOTA NADA (3-sep-2026). Textual: *"a mi como dueno
      // no me debo contar para nada; si yo me paro en un pedido yo no lo bloqueo
      // porque yo no llamo ni hago nada"*.
      //
      // Sin esta reja, mirar la operacion le escribia `abrio`, `cerro` y —lo
      // peor— `salto`: el dueno revisando pedidos quedaba registrado como
      // alguien que los abre y pasa de largo sin gestionar. Ese numero lo lee el
      // en `/actividad`, en el mapa de calor y en el resumen por persona, y lo
      // habria estado comparando contra el trabajo real de su equipo.
      //
      // Es la MISMA regla que ya cumplen el heartbeat, el reclamo de pedidos y
      // la marca de "en atencion" — esta era la unica puerta que faltaba.
      if (observa) return;
      if (EVENTOS_GESTION.has(evento) && opts.externalId) {
        const k = String(opts.externalId);
        GESTIONES_EN_VIVO.set(k, (GESTIONES_EN_VIVO.get(k) ?? 0) + 1);
      }
      COLA.push({
        store_id: activeStoreId,
        operator_id: user.id,
        external_id: opts.externalId ? String(opts.externalId) : null,
        phone: opts.phone || null,
        evento,
        detalle: opts.detalle ?? {},
        ms_en_pantalla: opts.msEnPantalla ?? null,
        created_at: new Date().toISOString(),
      });
      if (COLA.length >= TOPE_LOTE) void vaciar();
    },
    [user, activeStoreId, observa],
  );
}

/**
 * El pedido que está a la vista: abre, mide y cierra solo.
 *
 * Se le pasa el pedido que la pantalla está mostrando; cuando cambia, cierra el
 * anterior con su duración y abre el nuevo. Al desmontarse cierra el último.
 *
 * `salto` vs `cerro` lo decide si hubo alguna gestión mientras estuvo abierto:
 * eso es exactamente la diferencia entre "lo trabajó" y "pasó de largo", y es
 * el dato que hoy no existe en ningún lado. Para contarlas, la pantalla llama a
 * `marcarGestion()` cada vez que registra una — o simplemente usa el
 * `registrar` que devuelve, que ya las cuenta solo.
 */
export function usePedidoALaVista(pedido: { externalId?: string | null; phone?: string | null } | null) {
  const registrar = useBitacoraPedido();
  const actual = useRef<{ externalId: string | null; phone: string | null; desde: number; gestiones: number } | null>(null);

  // El `registrar` cambia de identidad cuando cambia el usuario o la tienda, y
  // eso NO es motivo para cerrar el pedido que la asesora tiene abierto.
  const registrarRef = useRef(registrar);
  useEffect(() => { registrarRef.current = registrar; }, [registrar]);

  const cerrarActual = useCallback(() => {
    const a = actual.current;
    if (!a) return;
    actual.current = null;
    const ms = msEnPantalla(a.desde, Date.now());
    // Las que contó esta instancia (`marcarGestion`) MÁS las que registraron
    // otras instancias sobre el mismo pedido mientras estuvo abierto.
    const vivas = a.externalId ? (GESTIONES_EN_VIVO.get(a.externalId) ?? 0) : 0;
    if (a.externalId) GESTIONES_EN_VIVO.delete(a.externalId);
    const gestiones = a.gestiones + vivas;
    registrarRef.current(esSalto(gestiones) ? 'salto' : 'cerro', {
      externalId: a.externalId,
      phone: a.phone,
      msEnPantalla: ms,
      detalle: { gestiones },
    });
  }, []);

  const clave = pedido?.externalId ? String(pedido.externalId) : null;
  const tel = pedido?.phone || null;

  useEffect(() => {
    // Mismo pedido que ya estaba abierto: no se reabre ni se reinicia el reloj.
    if (actual.current?.externalId === clave) return;
    cerrarActual();
    if (!clave) return;
    // Arranca en cero: una gestión de hace una hora sobre este mismo pedido no
    // convierte en "trabajado" el vistazo de ahora.
    GESTIONES_EN_VIVO.delete(clave);
    actual.current = { externalId: clave, phone: tel, desde: Date.now(), gestiones: 0 };
    registrarRef.current('abrio', { externalId: clave, phone: tel });
  }, [clave, tel, cerrarActual]);

  // Al desmontar (cambio de pantalla, cierre de sesión) se cierra el último.
  useEffect(() => () => { cerrarActual(); }, [cerrarActual]);

  /** Contar una gestión hecha sobre el pedido abierto — lo que convierte el
   *  próximo paso al siguiente en `cerro` en vez de `salto`. */
  const marcarGestion = useCallback(() => {
    if (actual.current) actual.current.gestiones += 1;
  }, []);

  /** Registrar algo Y contarlo como gestión, que es el caso normal. */
  const registrarGestion = useCallback(
    (evento: EventoPedido, opts: RegistrarOpciones = {}) => {
      const externalId = opts.externalId ?? actual.current?.externalId ?? clave;
      // Con externalId, `registrar` ya la suma en GESTIONES_EN_VIVO (que
      // `cerrarActual` agrega a las de esta instancia): contarla también acá
      // la dejaba DOBLE en `detalle.gestiones` (revisión 3-sep-2026). Solo sin
      // externalId —el Map no la ve— se cuenta localmente.
      if (!externalId) marcarGestion();
      registrarRef.current(evento, {
        externalId,
        phone: opts.phone ?? actual.current?.phone ?? tel,
        ...opts,
      });
    },
    [marcarGestion, clave, tel],
  );

  return { registrar, registrarGestion, marcarGestion };
}
