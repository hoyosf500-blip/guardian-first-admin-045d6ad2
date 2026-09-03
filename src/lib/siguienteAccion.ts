// src/lib/siguienteAccion.ts
//
// ¿Qué tiene que hacer AHORA la persona que está frente a Guardian?
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// Guardian YA calculaba esto y tiraba la respuesta. `InactivityGuard` mira las
// tres colas (Confirmar · Novedades · Seguimiento) para decidir si muestra el
// regaño por inactividad, y reduce todo a un `true/false`. O sea: la pregunta
// "¿qué hago ahora?" estaba resuelta cada segundo y no se le mostraba a nadie.
// El sistema sabía dirigir y solo se usaba para regañar.
//
// ── La escalera (decisión del dueño, 21-ago-2026) ───────────────────────────
// El orden NO es por antigüedad ni por monto: es **por lo que se pierde si
// espera un día más**. Sale de la auditoría de julio en Ecuador, donde 144 de
// 640 pedidos perdidos (22%) se perdieron porque algo no se hizo a tiempo —
// en horario laboral y con gente conectada.
//
//   1. NOVEDADES abiertas ....... la transportadora tiene el paquete detenido
//                                 esperando respuesta. Vence en horas. Y una
//                                 novedad resuelta antes del mediodía todavía
//                                 sale el mismo día.
//   2. AGENCIA con reloj ........ el cliente tiene que ir a retirarlo y la
//                                 transportadora lo guarda ~7 días. 76 devueltos
//                                 en julio EC ($2.316): la falla más cara medida.
//   3. CONFIRMAR ................ a los 4 días se cancela solo. De acá salieron
//                                 los 68 cancelados sin UNA gestión ($2.229).
//   4. DETENIDOS ................ +72h sin moverse. Acá NO se llama al cliente:
//                                 se le reclama a la transportadora.
//   5. RESCATE de devoluciones .. se llama UNA vez. De 49 re-emitidos en julio,
//                                 32 terminaron entregados.
//   6. RESTO DE SEGUIMIENTO ..... catch-all de las demás listas accionables
//                                 (indemnizaciones vencidas, pendientes de guía,
//                                 reparto/novedad). Ver el invariante de abajo.
//
// ── El invariante que sostiene todo ─────────────────────────────────────────
// **Si el guard de inactividad ve trabajo, la barra NO puede decir "al día".**
//
// Es una implicación en UN solo sentido, no una equivalencia. El peor resultado
// posible de esta pantalla es que a la asesora la regañen por estar quieta
// mientras la barra le dice que terminó: ahí la herramienta la contradice y
// pierde toda autoridad. Eso es lo que la prueba guardiana prohíbe.
//
// El sentido contrario SÍ está permitido y es deliberado: la barra puede
// ofrecer algo cuando el guard no exige nada. Pasa con el escalón 5
// (`devolucion_reciente`), que a propósito NO es accionable — la llamada de
// rescate se hace UNA vez, no se exige todos los días durante 30 días. Cuando
// es lo único que queda, la barra lo ofrece y el guard no molesta. Esa
// divergencia va en la dirección segura: ofrecer trabajo opcional nunca hace
// daño; regañar sin decir por qué, sí.
//
// El escalón 6 (catch-all) existe justamente para sostener la implicación: sin
// él, una lista accionable sin escalón propio —indemnizaciones vencidas,
// pendientes de guía, reparto/novedad— dejaba la barra en verde con el guard
// regañando. NO borrarlo "porque no se usa": es lo único que cubre esas listas.
//
// Puro: sin red, sin React, sin reloj implícito.

import type { OrderData } from './orderUtils';
import { findSegList, esAccionable, type SegListSlug } from './segLists';
import { estadoAvisoAgencia } from './avisoAgencia';

export type AccionKey =
  /** Un cliente escribió y nadie le contestó. Ver `HORAS_BANDEJA_URGENTE`. */
  | 'bandeja'
  /** Le escribimos y no contestó: falta el 2º intento. */
  | 'sin_respuesta'
  | 'novedades'
  | 'agencia'
  | 'confirmar'
  | 'detenidos'
  | 'rescate'
  | 'seguimiento'
  | 'al_dia'
  /** Todavía no se sabe: la cola de Seguimiento no está cargada. NO es "al día".
   *  Ver la regla de `segCargado` abajo. */
  | 'cargando';

export interface SiguienteAccion {
  key: AccionKey;
  /** Cuántos pedidos esperan en este escalón. 0 solo para `al_dia`. */
  cuantos: number;
  /** Qué se hace, en imperativo y en el idioma de la operadora. */
  titulo: string;
  /** Lo MISMO en neutro ("4 novedades abiertas"). Para el dueño/supervisor, que
   *  mira el estado de la cola y no la va a trabajar: darle una orden a quien no
   *  ejecuta es ruido. */
  etiqueta: string;
  /** Por qué esto va antes que lo demás. Una línea. */
  porque: string;
  /** Adónde la lleva el botón. */
  ruta: string;
  /** Urgencia, para el tono visual. */
  tono: 'urgente' | 'atencion' | 'normal' | 'listo';
  /**
   * Lo que queda DEBAJO del escalón que manda. Ver `EscalonPendiente`.
   *
   * Vacío cuando no hay nada más, y ausente jamás: es un arreglo siempre.
   */
  otros: EscalonPendiente[];
}

/**
 * Un escalón que tiene trabajo pero no es el que manda ahora.
 *
 * ⛔ POR QUE ESTO EXISTE (3-sep-2026, reportado por el dueno en produccion).
 * La barra devolvia UN escalon y tiraba el resto. Con la bandeja de Colombia en
 * 51 clientes esperando hace mas de 3 horas, el escalon de la bandeja gana
 * SIEMPRE — y va a seguir ganando hasta que alguien vacie esos 51. Durante todo
 * ese tiempo la barra no nombraba las novedades ni los pedidos por confirmar:
 * no es que los pusiera despues, es que no existian en la pantalla.
 *
 * Eso choca de frente con la regla del dueno: *"que Guardian no esconda
 * pedidos, que siempre muestre el total de lo que hay que trabajar"*. Un
 * backlog en el primer escalon no puede volver invisible a todo lo de abajo.
 *
 * La prioridad NO cambia — la eligio el dueno y sigue mandando quien manda. Lo
 * que cambia es que lo demas se NOMBRA al lado, con su numero y su ruta.
 */
export interface EscalonPendiente {
  key: Exclude<AccionKey, 'al_dia' | 'cargando'>;
  cuantos: number;
  /** Lo mismo que muestra la barra en neutro: "4 novedades abiertas". */
  etiqueta: string;
  ruta: string;
}

/** ¿Este pedido cae en esa lista SLA? Slug renombrado → false, nunca excepción. */
function matchLista(o: OrderData, slug: SegListSlug): boolean {
  const def = findSegList(slug);
  return def ? def.matches(o) : false;
}

/** Cuenta los pedidos de `segData` que caen en una lista SLA por su slug. */
function contarLista(segData: OrderData[], slug: SegListSlug): number {
  const def = findSegList(slug);
  if (!def) return 0; // slug renombrado → 0, nunca una excepción en pantalla
  let n = 0;
  for (const o of segData) if (def.matches(o)) n++;
  return n;
}

const rutaSeg = (slug: SegListSlug) => `/seguimiento?lista=${slug}`;

/**
 * A partir de cuántas horas un cliente esperando MANDA SOBRE TODO.
 *
 * ── La decisión del dueño (3-sep-2026) ──────────────────────────────────────
 * Se le ofrecieron tres órdenes y eligió éste: *"primero si lleva +3 horas"*.
 * Con menos de 3 h la bandeja entra después de Novedades y Agencia.
 *
 * El equilibrio que compra: una persona que lleva media mañana esperando
 * respuesta manda sobre un paquete detenido —porque se va a ir a la
 * competencia— pero un «ok, gracias» sin contestar NO tapa un paquete que se
 * devuelve mañana. Poner la bandeja siempre primera hacía exactamente eso.
 */
export const HORAS_BANDEJA_URGENTE = 3;

/**
 * La escalera, ESCRITA UNA SOLA VEZ.
 *
 * `siguienteAccion` saca de acá el "por qué" que muestra la barra, y la pantalla
 * `/como-se-trabaja` saca de acá la explicación completa. Es a propósito: una
 * página de ayuda escrita aparte se desincroniza del código en semanas y termina
 * enseñando un protocolo que el sistema ya no aplica. Si mañana cambia el orden
 * o el motivo, cambia en un solo lugar y las dos pantallas lo dicen igual.
 *
 * `queHacer` es lo que la ayuda agrega y la barra no tiene espacio de mostrar.
 */
export interface EscalonDoc {
  key: Exclude<AccionKey, 'al_dia' | 'cargando'>;
  /** Posición en la escalera, 1 = lo primero. */
  orden: number;
  /** Nombre del escalón en el idioma de la operación. */
  nombre: string;
  /** Por qué va antes que lo demás. Una línea — es lo que muestra la barra. */
  porque: string;
  /** El protocolo: qué se hace, concretamente. */
  queHacer: string;
  ruta: string;
}

export const ESCALERA: readonly EscalonDoc[] = [
  {
    key: 'bandeja',
    orden: 1,
    nombre: 'Clientes esperando respuesta',
    porque: 'Escribieron y nadie les contestó. Una persona esperando se va a la competencia.',
    queHacer:
      'Se contesta. Los que llevan más de 3 horas van ANTES que todo lo demás: a esa altura el cliente ya cree que no le van a responder. Los de menos de 3 horas entran después de Novedades y Agencia, porque un paquete que se devuelve mañana no puede esperar a que alguien conteste un «gracias».',
    ruta: '/inbox',
  },
  {
    key: 'novedades',
    orden: 2,
    nombre: 'Novedades abiertas',
    porque: 'La transportadora tiene el paquete detenido esperando respuesta.',
    queHacer:
      'Se responde la novedad el mismo día. Una novedad resuelta antes del mediodía todavía sale a reparto esa tarde; una resuelta a las 6 pierde el día entero. Si la transportadora ya cerró la novedad, el pedido pasa a "Esperando transportadora" y no se toca más.',
    ruta: '/novedades',
  },
  {
    key: 'agencia',
    orden: 3,
    nombre: 'Paquetes esperando en la agencia',
    porque: 'La transportadora lo guarda unos días y después lo devuelve sin avisar.',
    queHacer:
      'Día 2: se le avisa al cliente por el canal de siempre con la dirección de la agencia y el número de guía. Día 5: se lo llama. Después del día 7 la transportadora lo devuelve y el flete se paga igual. En julio en Ecuador se perdieron 76 pedidos así.',
    ruta: '/seguimiento?lista=agencia_2d',
  },
  {
    key: 'confirmar',
    orden: 4,
    nombre: 'Pedidos por confirmar',
    porque: 'Un pedido sin confirmar a los 4 días se cancela solo.',
    queHacer:
      'Se llama. Si no contesta se marca "No contestó" —no "Llamé"—, porque eso lo deja en la cola para el siguiente intento en vez de esconderlo. Tres intentos en días distintos antes de cancelar, y la cancelación va con su motivo real: ese motivo es lo único que después permite bajar las cancelaciones.',
    ruta: '/confirmar',
  },
  {
    key: 'sin_respuesta',
    orden: 5,
    nombre: 'Les escribimos y no contestaron',
    porque: 'Salió un mensaje y nadie volvió a mirar si respondieron.',
    queHacer:
      'Se hace el SEGUNDO intento. Mandar una plantilla y no volver a mirar no es haber gestionado: el pedido queda igual de solo que antes, pero con la sensación de que ya se atendió. Si tampoco contesta, se llama.',
    ruta: '/inbox',
  },
  {
    key: 'detenidos',
    orden: 6,
    nombre: 'Pedidos detenidos',
    porque: 'Llevan +72 h sin moverse. Acá se le reclama a la transportadora, no al cliente.',
    queHacer:
      'Se reclama a la transportadora con la guía en la mano. Al cliente NO se lo llama para decirle que su pedido está trabado: no puede hacer nada con esa información y aumenta la cancelación. Si la transportadora no responde en 24 h, se escala.',
    ruta: '/seguimiento?lista=detenidos_3d',
  },
  {
    key: 'rescate',
    orden: 7,
    nombre: 'Rescate de devoluciones',
    porque: 'Cancelado no es perdido: en julio, 32 de 49 pedidos re-emitidos terminaron entregados.',
    queHacer:
      'Se llama UNA vez y se pregunta qué pasó. Si todavía lo quiere, se vuelve a emitir. Esta llamada no se repite todos los días: se hace una vez y se deja anotado el resultado.',
    ruta: '/seguimiento?lista=devolucion_reciente',
  },
  {
    key: 'seguimiento',
    orden: 8,
    nombre: 'El resto de Seguimiento',
    porque: 'Indemnizaciones vencidas, pendientes de guía y reparto.',
    queHacer:
      'Lo que quedó de las listas con reloj: indemnizaciones que ya se pueden reclamar, pedidos sin guía hace días. Se trabaja cuando lo de arriba está en cero.',
    ruta: '/seguimiento',
  },
] as const;

const doc = (k: EscalonDoc['key']): EscalonDoc => ESCALERA.find((e) => e.key === k)!;

/**
 * Lo que se VIGILA y no se gestiona.
 *
 * Está acá y no en la pantalla porque es la mitad menos obvia del protocolo:
 * tener a alguien ocupado no sirve si está ocupado en lo que no vence. Un
 * pedido en tránsito no necesita a nadie — necesita tiempo.
 */
export const NO_ES_TRABAJO: readonly { que: string; porque: string }[] = [
  { que: 'En tránsito', porque: 'Va camino al cliente y avanza solo. Llamar acá no lo acelera.' },
  { que: 'Guía generada', porque: 'La transportadora todavía no lo recogió. Se vuelve trabajo si pasan días sin moverse — y ahí aparece en "Detenidos".' },
  { que: 'En reparto', porque: 'El repartidor lo tiene hoy. Se resuelve solo o vuelve como novedad.' },
  { que: 'Entregado / Cancelado', porque: 'Terminaron. Se miran para entender el mes, no para trabajarlos.' },
];

export interface SiguienteAccionInput {
  /** Cola de Confirmar (se cuentan los que NO tienen `result`). */
  workQueue: OrderData[];
  /** Novedades abiertas. */
  novedadesQueue: OrderData[];
  /** Pedidos de Seguimiento cargados. */
  segData: OrderData[];
  /**
   * ¿`segData` YA se leyó de la base?
   *
   * ⛔ **Un arreglo verificado en producción (21-ago-2026).** `segData` solo se
   * carga cuando la persona entra a `/seguimiento`, y la barra se esconde
   * justamente en esa pantalla. O sea: en toda pantalla donde la barra SE VE,
   * la cola de Seguimiento llegaba vacía → cuatro de los seis escalones
   * (agencia, detenidos, rescate y el catch-all) no podían dispararse NUNCA, y
   * la barra decía "Todo al día" en verde con 7 detenidos y 5 paquetes
   * esperando en una agencia. Medido en el Dashboard de Colombia.
   *
   * La causa de fondo se arregla cargando la cola desde el layout, pero el
   * instante inicial —y una query caída— siguen existiendo. En ese hueco la
   * respuesta honesta es "todavía no sé", nunca un cero: es la misma regla de
   * `turnoDelEquipo` (cero NUNCA sustituye a "no se pudo medir").
   *
   * Default `true` para no cambiar los call-sites que ya pasan datos leídos.
   */
  segCargado?: boolean;
  /**
   * `phone → ms` del último «Avisé: en oficina» (de `useSegTouchIndex`).
   *
   * Cuando viene, el escalón de aviso cuenta SOLO a los clientes que todavía no
   * saben que su paquete llegó. Una barra que pide avisar a 20 cuando a 18 ya
   * se les avisó enseña a ignorarla, y ese es el modo en que una barra de
   * prioridad se muere. Ausente (default) = se cuenta todo, como antes.
   */
  avisosAgencia?: Map<string, number>;
  /**
   * Cuántas de esas novedades siguen ABIERTAS en Dropi.
   *
   * ⛔ **Medido el 28-ago-2026, tienda de Ecuador.** La barra anunciaba
   * *"84 novedades abiertas"* mientras el panel de Dropi mostraba **14**. Las
   * dos cifras eran ciertas y contaban cosas distintas: `novedadesQueue` son
   * los pedidos parados en estado NOVEDAD (Dropi mismo reporta 85 en su lista
   * de pedidos, o sea Guardian no infla nada) y el panel de Dropi lista las
   * INCIDENCIAS abiertas. Las otras 70 las cerró o las dejó vencer la
   * transportadora: Dropi **rechaza** resolverlas, así que no son trabajo.
   *
   * Anunciar 84 en rojo, arriba de todo, en el primer escalón de la escalera,
   * manda al equipo a una cola donde 6 de cada 7 no tienen nada que hacer — y
   * enseña a ignorar la barra, que es como muere una barra de prioridad.
   *
   * `null`/ausente = no se pudo leer (edge caída, sesión Dropi vencida) → se
   * cuenta la cola entera, exactamente como antes. Cero nunca sustituye a "no
   * se pudo medir", y la incertidumbre no puede esconder trabajo real.
   */
  novedadesAbiertas?: number | null;
  /**
   * Clientes que escribieron y siguen sin respuesta, y cuántos de ellos llevan
   * más de `HORAS_BANDEJA_URGENTE`.
   *
   * ⛔ `null`/ausente = NO SE PUDO MEDIR, y entonces el escalón no se dispara.
   * Es la misma regla que ya tiene `novedadesAbiertas`, y acá pesa el doble: la
   * bandeja distingue explícitamente «nadie esperando» de «todavía no puedo
   * medir quién espera» (`useInboxEsperando`), justo por el incidente de
   * Colombia — la pantalla celebraba «todos atendidos 🎉» con 39 clientes
   * esperando, 22 de ellos hacía más de un día. Un escalón que se dispara con
   * un cero inventado es el mismo error, al revés.
   */
  bandejaEsperando?: number | null;
  bandejaUrgentes?: number | null;
  /** Clientes a los que les escribimos y no contestaron: falta el 2º intento. */
  sinRespuesta?: number | null;
}

/**
 * Devuelve el ÚNICO escalón que toca ahora. No una lista de pendientes: una
 * instrucción. Si la persona tiene que elegir entre pantallas va a elegir la
 * más cómoda, y la más cómoda nunca es la que vence.
 */
/** Un escalon todavia sin `otros`: lo agrega el ensamblado del final. */
type Escalon = Omit<SiguienteAccion, 'otros'>;

export function siguienteAccion(input: SiguienteAccionInput): SiguienteAccion {
  const {
    workQueue, novedadesQueue, segData, segCargado = true, avisosAgencia, novedadesAbiertas,
    bandejaEsperando, bandejaUrgentes, sinRespuesta,
  } = input;

  // ⛔ SE EVALUA LA ESCALERA ENTERA, NO SE CORTA EN EL PRIMERO.
  //
  // Hasta el 3-sep-2026 cada escalon hacia `return` y lo de abajo no llegaba a
  // calcularse. Con 51 clientes esperando hace +3 h en la bandeja, el primer
  // escalon gana todos los dias y las novedades y los pedidos por confirmar
  // dejaban de existir en la pantalla. Ahora se juntan TODOS los que tienen
  // trabajo: el primero sigue siendo el que manda —la prioridad no se toca— y
  // el resto se nombra al lado. Ver `EscalonPendiente`.
  const escalones: Escalon[] = [];

  // ── 0. Bandeja URGENTE: alguien esperando hace más de 3 h ─────────
  // Manda sobre todo, incluso sobre una novedad. Decisión del dueño: a esa
  // altura el cliente ya cree que no le van a contestar, y eso no se recupera
  // resolviendo el paquete al día siguiente.
  const urgentesBandeja = bandejaUrgentes ?? 0;
  if (urgentesBandeja > 0) {
    escalones.push({
      key: 'bandeja',
      cuantos: urgentesBandeja,
      titulo: urgentesBandeja === 1
        ? 'Contestale: lleva más de 3 horas esperando'
        : `Contestales: ${urgentesBandeja} llevan más de 3 horas esperando`,
      etiqueta: urgentesBandeja === 1
        ? '1 cliente esperando hace +3 h'
        : `${urgentesBandeja} clientes esperando hace +3 h`,
      porque: doc('bandeja').porque,
      ruta: '/inbox',
      tono: 'urgente',
    });
  }

  // ── 1. Novedades ──────────────────────────────────────────────────
  // Solo las que Dropi todavía deja gestionar. Ver `novedadesAbiertas`.
  const novedades = novedadesAbiertas ?? novedadesQueue.length;
  const esperando = novedadesAbiertas == null ? 0 : Math.max(0, novedadesQueue.length - novedadesAbiertas);
  if (novedades > 0) {
    escalones.push({
      key: 'novedades',
      cuantos: novedades,
      titulo: novedades === 1 ? 'Resolvé la novedad abierta' : `Resolvé las ${novedades} novedades abiertas`,
      etiqueta: novedades === 1 ? '1 novedad abierta' : `${novedades} novedades abiertas`,
      // Se nombra lo que NO es trabajo. Sin esta línea, el que ayer leyó "84" y
      // hoy lee "14" va a creer que se perdieron pedidos.
      porque: esperando > 0
        ? `${doc('novedades').porque} (${esperando} más están en estado NOVEDAD pero la transportadora ya cerró la incidencia: no se pueden gestionar.)`
        : doc('novedades').porque,
      ruta: '/novedades',
      tono: 'urgente',
    });
  }

  // ── 2. Agencia con reloj ──────────────────────────────────────────
  // Dos tramos del MISMO protocolo, y el escalón escala con ellos: a las 48 h
  // se avisa, a las 120 h se llama porque quedan dos días antes de que la
  // transportadora lo devuelva. Los que ya cruzaron los 5 días mandan sobre los
  // de 2 aunque sean menos: son los que se pierden esta semana.
  const agenciaUrge = segCargado ? contarLista(segData, 'agencia_5d') : 0;
  // El tramo de 5 días NO se filtra por aviso: ahí lo que toca es LLAMAR, se
  // haya avisado o no. El de 2 días sí, porque su trabajo es exactamente el
  // aviso que quizá ya se dio.
  const agenciaAviso = segCargado
    ? (avisosAgencia
        ? segData.reduce((n, o) => {
            if (!matchLista(o, 'agencia_2d')) return n;
            const llegadaMs = o.lastMovementAt ? new Date(o.lastMovementAt).getTime() : null;
            const avisoMs = o.phone ? avisosAgencia.get(o.phone) ?? null : null;
            return estadoAvisoAgencia({ llegadaMs, avisoMs }) === 'sin_avisar' ? n + 1 : n;
          }, 0)
        : contarLista(segData, 'agencia_2d'))
    : 0;
  if (agenciaUrge > 0) {
    escalones.push({
      key: 'agencia',
      cuantos: agenciaUrge,
      titulo: agenciaUrge === 1
        ? 'Llamá al cliente: su paquete se devuelve en dos días'
        : `Llamá a ${agenciaUrge} clientes: sus paquetes se devuelven en dos días`,
      etiqueta: agenciaUrge === 1
        ? '1 paquete a punto de devolverse'
        : `${agenciaUrge} paquetes a punto de devolverse`,
      porque: doc('agencia').porque,
      ruta: rutaSeg('agencia_5d'),
      tono: 'urgente',
    });
  }
  if (agenciaAviso > 0) {
    escalones.push({
      key: 'agencia',
      cuantos: agenciaAviso,
      titulo: agenciaAviso === 1
        ? 'Avisá al cliente que su paquete está en la agencia'
        : `Avisá a ${agenciaAviso} clientes que su paquete está en la agencia`,
      etiqueta: agenciaAviso === 1 ? '1 paquete esperando en la agencia' : `${agenciaAviso} paquetes esperando en la agencia`,
      porque: doc('agencia').porque,
      ruta: rutaSeg('agencia_2d'),
      tono: 'urgente',
    });
  }

  // ── 2.5. Bandeja: los que llevan menos de 3 h ─────────────────────
  const esperandoBandeja = bandejaEsperando ?? 0;
  if (esperandoBandeja > 0) {
    escalones.push({
      key: 'bandeja',
      cuantos: esperandoBandeja,
      titulo: esperandoBandeja === 1
        ? 'Contestale al cliente que escribió'
        : `Contestales a los ${esperandoBandeja} clientes que escribieron`,
      etiqueta: esperandoBandeja === 1 ? '1 cliente esperando respuesta' : `${esperandoBandeja} clientes esperando respuesta`,
      porque: doc('bandeja').porque,
      ruta: '/inbox',
      tono: 'atencion',
    });
  }

  // ── 3. Confirmar ──────────────────────────────────────────────────
  // `!o.result` = todavía no se gestionó hoy. Mismo criterio que usa el guard.
  const porConfirmar = workQueue.reduce((n, o) => (o.result ? n : n + 1), 0);
  if (porConfirmar > 0) {
    escalones.push({
      key: 'confirmar',
      cuantos: porConfirmar,
      titulo: porConfirmar === 1 ? 'Confirmá el pedido pendiente' : `Confirmá los ${porConfirmar} pedidos pendientes`,
      etiqueta: porConfirmar === 1 ? '1 pedido por confirmar' : `${porConfirmar} pedidos por confirmar`,
      porque: doc('confirmar').porque,
      ruta: '/confirmar',
      tono: 'atencion',
    });
  }

  // ── 3.5. Les escribimos y no contestaron ──────────────────────────
  // El caso del supervisor que manda la plantilla de un clic y no vuelve a
  // mirar. Va DESPUÉS de Confirmar porque el 2º intento no vence hoy; va antes
  // que Detenidos porque acá todavía hay un cliente que se puede recuperar.
  const deuda = sinRespuesta ?? 0;
  if (deuda > 0) {
    escalones.push({
      key: 'sin_respuesta',
      cuantos: deuda,
      titulo: deuda === 1
        ? 'Hacé el 2º intento con el que no contestó'
        : `Hacé el 2º intento con ${deuda} que no contestaron`,
      etiqueta: deuda === 1 ? '1 sin respuesta desde ayer' : `${deuda} sin respuesta`,
      porque: doc('sin_respuesta').porque,
      ruta: '/inbox',
      tono: 'normal',
    });
  }

  // ── 4. Detenidos ──────────────────────────────────────────────────
  const detenidos = segCargado ? contarLista(segData, 'detenidos_3d') : 0;
  if (detenidos > 0) {
    escalones.push({
      key: 'detenidos',
      cuantos: detenidos,
      titulo: detenidos === 1 ? 'Reclamá el pedido detenido' : `Reclamá los ${detenidos} pedidos detenidos`,
      etiqueta: detenidos === 1 ? '1 pedido detenido' : `${detenidos} pedidos detenidos`,
      porque: doc('detenidos').porque,
      ruta: rutaSeg('detenidos_3d'),
      tono: 'atencion',
    });
  }

  // ── 5. Rescate de devoluciones ────────────────────────────────────
  const rescate = segCargado ? contarLista(segData, 'devolucion_reciente') : 0;
  if (rescate > 0) {
    escalones.push({
      key: 'rescate',
      cuantos: rescate,
      titulo: rescate === 1 ? 'Intentá rescatar la devolución' : `Intentá rescatar ${rescate} devoluciones`,
      etiqueta: rescate === 1 ? '1 devolución para rescatar' : `${rescate} devoluciones para rescatar`,
      porque: doc('rescate').porque,
      ruta: rutaSeg('devolucion_reciente'),
      tono: 'normal',
    });
  }

  // ── 6. Catch-all de Seguimiento ───────────────────────────────────
  // Sostiene el invariante: si el guard considera que hay trabajo, la barra
  // NO puede decir "al día". Sin este escalón, 20 indemnizaciones vencidas
  // dejaban la barra en verde mientras el guard regañaba.
  const restoSeg = segCargado ? segData.reduce((n, o) => (esAccionable(o) ? n + 1 : n), 0) : 0;
  if (restoSeg > 0) {
    escalones.push({
      key: 'seguimiento',
      cuantos: restoSeg,
      titulo: restoSeg === 1 ? 'Gestioná el pedido de Seguimiento' : `Gestioná los ${restoSeg} pedidos de Seguimiento`,
      etiqueta: restoSeg === 1 ? '1 pedido de Seguimiento sin gestionar' : `${restoSeg} pedidos de Seguimiento sin gestionar`,
      porque: doc('seguimiento').porque,
      ruta: '/seguimiento',
      tono: 'normal',
    });
  }

  // ── El escalon que manda, y lo que queda debajo ───────────────────
  if (escalones.length > 0) {
    const [primero, ...resto] = escalones;
    // Un escalon no se nombra dos veces. La bandeja tiene dos tramos (+3 h y
    // el resto) y la agencia tambien (5 dias y 2 dias): son el MISMO trabajo en
    // la MISMA pantalla, y dos chips al mismo lugar solo ensucian.
    const vistos = new Set<string>([primero.key]);
    // ⛔ El catch-all cuenta TODOS los accionables de Seguimiento, incluidos los
    // que ya tienen escalon propio (agencia, detenidos). Como escalon principal
    // eso nunca se ve —solo llega cuando los otros estan en cero— pero al
    // ponerlo AL LADO de ellos sumaria los mismos pedidos dos veces. Un numero
    // inflado en la barra vale menos que no ponerlo: se omite.
    const haySegPropio = escalones.some((e) => e.key === 'agencia' || e.key === 'detenidos' || e.key === 'rescate');
    const otros: EscalonPendiente[] = [];
    for (const e of resto) {
      if (vistos.has(e.key)) continue;
      if (e.key === 'seguimiento' && haySegPropio) continue;
      vistos.add(e.key);
      otros.push({ key: e.key as EscalonPendiente['key'], cuantos: e.cuantos, etiqueta: e.etiqueta, ruta: e.ruta });
    }
    return { ...primero, otros };
  }

  // ── Sin la cola de Seguimiento no se puede afirmar nada ───────────
  // Novedades y Confirmar ya se descartaron con datos reales; lo que falta
  // vive en `segData`. Decir "Todo al día" acá sería inventar.
  if (!segCargado) {
    return {
      key: 'cargando',
      cuantos: 0,
      titulo: 'Revisando la cola…',
      etiqueta: 'Revisando la cola…',
      porque: 'Todavía no se leyó la cola de Seguimiento.',
      ruta: '/seguimiento',
      tono: 'normal',
      otros: [],
    };
  }

  // ── Nada pendiente ────────────────────────────────────────────────
  return {
    key: 'al_dia',
    cuantos: 0,
    titulo: 'Todo al día',
    etiqueta: 'Todo al día',
    porque: 'No hay nada que venza ahora. Los pedidos en tránsito se vigilan, no se gestionan.',
    ruta: '/seguimiento',
    tono: 'listo',
    otros: [],
  };
}

/**
 * ¿La barra tiene algo que ofrecer?
 *
 * SUPERCONJUNTO de lo que el guard de inactividad considera trabajo: incluye el
 * rescate de devoluciones, que es opcional (ver el invariante arriba). Sirve
 * para decidir si la barra se pinta como "hay algo" o como "al día"; NO para
 * decidir si se regaña a alguien.
 */
export function hayTrabajo(input: SiguienteAccionInput): boolean {
  const k = siguienteAccion(input).key;
  return k !== 'al_dia' && k !== 'cargando';
}
