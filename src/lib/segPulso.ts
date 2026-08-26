/**
 * Las dos preguntas que la pantalla de Seguimiento no estaba contestando.
 *
 * El hero decía "222 por gestionar" y la tarjeta de al lado decía "222 TOTAL",
 * y abajo el chip "Todas 222". El mismo número tres veces: dos de esos tres
 * lugares no aportaban nada. Lo que SÍ falta a primera vista es:
 *
 *   1. ¿Cuántos están DETENIDOS? — el paquete que no se mueve hace días es el
 *      que termina en devolución. Estaba solo como puntito de color dentro de
 *      cada tarjeta: para contarlos había que recorrer 15 columnas a ojo.
 *   2. ¿El equipo está trabajando esto HOY? — el 31-jul Ecuador registró UNA
 *      gestión en todo el día con 229 pedidos en la calle, y no había forma de
 *      notarlo desde la pantalla. El dueño se enteró porque se lo contaron.
 *
 * Puro y sin React: se testea sin DOM, y el tablero y las tarjetas de arriba
 * leen de acá para que no puedan volver a contradecirse (el bug del contador
 * "Gestionados 0 de 222" nació justo de tener dos definiciones distintas de
 * "gestionado" en la misma pantalla).
 */
import { parseDate, type OrderData } from './orderUtils';
import { classifySegEstado, type SegStatusKey } from './segStatus';
import { esContactoEfectivo } from './segMetodosEstado';

/**
 * Fases donde TODAVÍA se puede hacer algo. Un ENTREGADO no está "detenido":
 * llegó. Espeja `LIVE_KEYS` del tablero — si se agrega una fase viva, va en
 * los dos lados.
 */
export const FASES_VIVAS: ReadonlySet<SegStatusKey> = new Set<SegStatusKey>([
  'procesamiento', 'guia', 'bodega_trans', 'transito', 'reparto', 'oficina', 'novedad', 'novedad_sol',
]);

/** A partir de acá el pedido se considera detenido. 72 h = el rojo del punto de
 *  frescura que ya usa cada tarjeta; el número sale del MISMO umbral para que la
 *  cuenta de arriba y los puntos de abajo nunca digan cosas distintas. */
export const HORAS_DETENIDO = 72;

/**
 * Horas desde el último movimiento real en Dropi. `null` si no hay fecha.
 *
 * NO usar `parseDate` acá. `parseDate` ancla a MEDIANOCHE UTC a propósito —
 * es lo correcto para contar días CALENDARIO, que es para lo que existe— pero
 * con eso TIRA LA HORA. `last_movement_at` es un timestamp con hora real: un
 * pedido movido ayer a las 18:00 se contaba como movido a las 00:00, o sea 18 h
 * de quietud inventadas. Hasta 24 h de más, y siempre para el mismo lado.
 *
 * Se notaba en dos lugares a la vez: el punto de la tarjeta se ponía rojo casi
 * un día antes de tiempo, y DETENIDOS contaba pedidos parados hace 50 h como si
 * llevaran 72. El número que el dueño mira para decidir a quién apurar venía
 * inflado. `CrmCallView` ya medía bien (usa el timestamp crudo) — eran dos
 * definiciones de la misma cuenta, y la de la pantalla era la equivocada.
 */
export function horasSinMovimiento(o: OrderData, ahoraMs: number = Date.now()): number | null {
  const iso = o.lastMovementAt;
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isFinite(ms)) return (ahoraMs - ms) / 3_600_000;
  // Formato raro (no ISO): al menos el día. Perder la hora es mejor que perder
  // el pedido — sin esto una fecha con otro formato lo mandaba a "no sé".
  const d = parseDate(iso);
  return d ? (ahoraMs - d.getTime()) / 3_600_000 : null;
}

/**
 * Días CALENDARIO desde el último movimiento real en Dropi. `null` si no hay fecha.
 *
 * Es la edad de la NOVEDAD (o de la quietud), NO la edad del pedido. Existe
 * porque la vista de Novedades mostraba `o.dias` —días desde que se CREÓ el
 * pedido— en el badge de urgencia: una novedad que salió AYER sobre un pedido de
 * 12 días se pintaba "D12 crítica", como si la novedad llevara 12 días abierta.
 * El dueño llegó a regañar al equipo por una demora que no existía. Acá el número
 * dice la verdad: hace cuánto no se mueve.
 *
 * `floor` a propósito: 20 h de quietud son 0 días completos, no "1". Un pedido
 * movido ayer 18:00 y mirado hoy 14:00 = ~20 h → D0 (hoy), no D1.
 */
export function diasSinMovimiento(o: OrderData, ahoraMs: number = Date.now()): number | null {
  const h = horasSinMovimiento(o, ahoraMs);
  return h == null ? null : Math.floor(h / 24);
}

/**
 * ¿Este pedido está detenido? Solo cuentan los que siguen en juego: un pedido
 * entregado hace un mes no se movió nunca más, y contarlo ahogaría la cifra en
 * ruido justo cuando tiene que gritar.
 *
 * Sin fecha de movimiento devuelve `false`: no saber cuándo se movió no es lo
 * mismo que saber que está quieto, y un número inflado con "no sé" deja de
 * servir para decidir.
 */
export function estaDetenido(o: OrderData, ahoraMs: number = Date.now()): boolean {
  // 'otros' —un estado que Dropi invente y que el clasificador todavía no
  // conoce— cuenta como VIVO. El guard estaba escrito al revés (todo lo que no
  // es fase viva se descarta), así que un rótulo nuevo desaparecía del contador:
  // 40 pedidos parados diez días daban DETENIDOS 0. Un pedido en estado
  // desconocido es exactamente el que hay que ir a mirar, no el que hay que
  // esconder. Es el caso de los 238 pedidos EC sin clasificar de julio.
  const fase = classifySegEstado(o.estado || '');
  if (fase !== 'otros' && !FASES_VIVAS.has(fase)) return false;
  const h = horasSinMovimiento(o, ahoraMs);
  return h != null && h >= HORAS_DETENIDO;
}

/**
 * ¿Alguien ya trabajó hoy este pedido?
 *
 * ÚNICA definición de "gestionado" de la pantalla. Existía por duplicado: el
 * tablero escondía las tarjetas que trabajó CUALQUIERA, pero el contador de
 * arriba solo sumaba las MÍAS. Resultado: las tarjetas desaparecían y el número
 * seguía clavado en 222. Para el dueño —que mira pero no gestiona— ese número
 * no bajaba nunca, por mucho que el equipo trabajara.
 *
 *  - `mios` (mySegTouchedToday): lo que YO registré. Cuenta siempre, incluso un
 *    "no contestó": acabo de tocarlo y volver a marcarlo duplicaría el registro.
 *  - `equipo` (gestionSegPorTelefono): lo de la compañera. Cuenta solo si HUBO
 *    CONTACTO — su "no contestó" deja el pedido pendiente para todo el mundo.
 */
export function estaGestionadoHoy(
  phone: string | null | undefined,
  mios: Set<string> | null | undefined,
  equipo: Map<string, { ultimoResult: string }> | null | undefined,
): boolean {
  if (!phone) return false;
  if (mios?.has(phone)) return true;
  const g = equipo?.get(phone);
  return !!g && esContactoEfectivo(g.ultimoResult);
}

/** Cuántos del lote ya trabajó alguien hoy. */
export function contarGestionadosHoy(
  pedidos: readonly OrderData[],
  mios: Set<string> | null | undefined,
  equipo: Map<string, { ultimoResult: string }> | null | undefined,
): number {
  let n = 0;
  for (const o of pedidos) if (estaGestionadoHoy(o.phone, mios, equipo)) n += 1;
  return n;
}

export interface AsesoraEnSeguimiento {
  operatorId: string;
  /** Teléfonos distintos que tocó hoy — no gestiones sueltas: llamar tres veces
   *  al mismo cliente es un pedido trabajado, no tres. */
  pedidos: number;
}

/**
 * Quién del equipo trabajó Seguimiento hoy y cuánto.
 *
 * Se limita a los pedidos que están A LA VISTA (`pedidos`): una gestión sobre
 * algo que hoy no está en la lista no debería sumarle a nadie en esta pantalla.
 */
export function asesorasEnSeguimientoHoy(
  pedidos: readonly OrderData[],
  equipo: Map<string, { ultimoPor: string | null }> | null | undefined,
): AsesoraEnSeguimiento[] {
  if (!equipo?.size) return [];
  const porOperador = new Map<string, Set<string>>();
  for (const o of pedidos) {
    if (!o.phone) continue;
    const g = equipo.get(o.phone);
    if (!g?.ultimoPor) continue;
    const set = porOperador.get(g.ultimoPor);
    if (set) set.add(o.phone);
    else porOperador.set(g.ultimoPor, new Set([o.phone]));
  }
  return [...porOperador.entries()]
    .map(([operatorId, set]) => ({ operatorId, pedidos: set.size }))
    // Empate por id para que las fichas no bailen entre refrescos de realtime.
    .sort((a, b) => b.pedidos - a.pedidos || a.operatorId.localeCompare(b.operatorId));
}
