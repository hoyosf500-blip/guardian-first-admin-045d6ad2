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
    key: 'novedades',
    orden: 1,
    nombre: 'Novedades abiertas',
    porque: 'La transportadora tiene el paquete detenido esperando respuesta.',
    queHacer:
      'Se responde la novedad el mismo día. Una novedad resuelta antes del mediodía todavía sale a reparto esa tarde; una resuelta a las 6 pierde el día entero. Si la transportadora ya cerró la novedad, el pedido pasa a "Esperando transportadora" y no se toca más.',
    ruta: '/novedades',
  },
  {
    key: 'agencia',
    orden: 2,
    nombre: 'Paquetes esperando en la agencia',
    porque: 'La transportadora lo guarda unos días y después lo devuelve sin avisar.',
    queHacer:
      'Día 2: se le avisa al cliente por el canal de siempre con la dirección de la agencia y el número de guía. Día 5: se lo llama. Después del día 7 la transportadora lo devuelve y el flete se paga igual. En julio en Ecuador se perdieron 76 pedidos así.',
    ruta: '/seguimiento?lista=agencia_2d',
  },
  {
    key: 'confirmar',
    orden: 3,
    nombre: 'Pedidos por confirmar',
    porque: 'Un pedido sin confirmar a los 4 días se cancela solo.',
    queHacer:
      'Se llama. Si no contesta se marca "No contestó" —no "Llamé"—, porque eso lo deja en la cola para el siguiente intento en vez de esconderlo. Tres intentos en días distintos antes de cancelar, y la cancelación va con su motivo real: ese motivo es lo único que después permite bajar las cancelaciones.',
    ruta: '/confirmar',
  },
  {
    key: 'detenidos',
    orden: 4,
    nombre: 'Pedidos detenidos',
    porque: 'Llevan +72 h sin moverse. Acá se le reclama a la transportadora, no al cliente.',
    queHacer:
      'Se reclama a la transportadora con la guía en la mano. Al cliente NO se lo llama para decirle que su pedido está trabado: no puede hacer nada con esa información y aumenta la cancelación. Si la transportadora no responde en 24 h, se escala.',
    ruta: '/seguimiento?lista=detenidos_3d',
  },
  {
    key: 'rescate',
    orden: 5,
    nombre: 'Rescate de devoluciones',
    porque: 'Cancelado no es perdido: en julio, 32 de 49 pedidos re-emitidos terminaron entregados.',
    queHacer:
      'Se llama UNA vez y se pregunta qué pasó. Si todavía lo quiere, se vuelve a emitir. Esta llamada no se repite todos los días: se hace una vez y se deja anotado el resultado.',
    ruta: '/seguimiento?lista=devolucion_reciente',
  },
  {
    key: 'seguimiento',
    orden: 6,
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
}

/**
 * Devuelve el ÚNICO escalón que toca ahora. No una lista de pendientes: una
 * instrucción. Si la persona tiene que elegir entre pantallas va a elegir la
 * más cómoda, y la más cómoda nunca es la que vence.
 */
export function siguienteAccion(input: SiguienteAccionInput): SiguienteAccion {
  const { workQueue, novedadesQueue, segData, segCargado = true, avisosAgencia } = input;

  // ── 1. Novedades ──────────────────────────────────────────────────
  const novedades = novedadesQueue.length;
  if (novedades > 0) {
    return {
      key: 'novedades',
      cuantos: novedades,
      titulo: novedades === 1 ? 'Resolvé la novedad abierta' : `Resolvé las ${novedades} novedades abiertas`,
      etiqueta: novedades === 1 ? '1 novedad abierta' : `${novedades} novedades abiertas`,
      porque: doc('novedades').porque,
      ruta: '/novedades',
      tono: 'urgente',
    };
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
    return {
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
    };
  }
  if (agenciaAviso > 0) {
    return {
      key: 'agencia',
      cuantos: agenciaAviso,
      titulo: agenciaAviso === 1
        ? 'Avisá al cliente que su paquete está en la agencia'
        : `Avisá a ${agenciaAviso} clientes que su paquete está en la agencia`,
      etiqueta: agenciaAviso === 1 ? '1 paquete esperando en la agencia' : `${agenciaAviso} paquetes esperando en la agencia`,
      porque: doc('agencia').porque,
      ruta: rutaSeg('agencia_2d'),
      tono: 'urgente',
    };
  }

  // ── 3. Confirmar ──────────────────────────────────────────────────
  // `!o.result` = todavía no se gestionó hoy. Mismo criterio que usa el guard.
  const porConfirmar = workQueue.reduce((n, o) => (o.result ? n : n + 1), 0);
  if (porConfirmar > 0) {
    return {
      key: 'confirmar',
      cuantos: porConfirmar,
      titulo: porConfirmar === 1 ? 'Confirmá el pedido pendiente' : `Confirmá los ${porConfirmar} pedidos pendientes`,
      etiqueta: porConfirmar === 1 ? '1 pedido por confirmar' : `${porConfirmar} pedidos por confirmar`,
      porque: doc('confirmar').porque,
      ruta: '/confirmar',
      tono: 'atencion',
    };
  }

  // ── 4. Detenidos ──────────────────────────────────────────────────
  const detenidos = segCargado ? contarLista(segData, 'detenidos_3d') : 0;
  if (detenidos > 0) {
    return {
      key: 'detenidos',
      cuantos: detenidos,
      titulo: detenidos === 1 ? 'Reclamá el pedido detenido' : `Reclamá los ${detenidos} pedidos detenidos`,
      etiqueta: detenidos === 1 ? '1 pedido detenido' : `${detenidos} pedidos detenidos`,
      porque: doc('detenidos').porque,
      ruta: rutaSeg('detenidos_3d'),
      tono: 'atencion',
    };
  }

  // ── 5. Rescate de devoluciones ────────────────────────────────────
  const rescate = segCargado ? contarLista(segData, 'devolucion_reciente') : 0;
  if (rescate > 0) {
    return {
      key: 'rescate',
      cuantos: rescate,
      titulo: rescate === 1 ? 'Intentá rescatar la devolución' : `Intentá rescatar ${rescate} devoluciones`,
      etiqueta: rescate === 1 ? '1 devolución para rescatar' : `${rescate} devoluciones para rescatar`,
      porque: doc('rescate').porque,
      ruta: rutaSeg('devolucion_reciente'),
      tono: 'normal',
    };
  }

  // ── 6. Catch-all de Seguimiento ───────────────────────────────────
  // Sostiene el invariante: si el guard considera que hay trabajo, la barra
  // NO puede decir "al día". Sin este escalón, 20 indemnizaciones vencidas
  // dejaban la barra en verde mientras el guard regañaba.
  const restoSeg = segCargado ? segData.reduce((n, o) => (esAccionable(o) ? n + 1 : n), 0) : 0;
  if (restoSeg > 0) {
    return {
      key: 'seguimiento',
      cuantos: restoSeg,
      titulo: restoSeg === 1 ? 'Gestioná el pedido de Seguimiento' : `Gestioná los ${restoSeg} pedidos de Seguimiento`,
      etiqueta: restoSeg === 1 ? '1 pedido de Seguimiento sin gestionar' : `${restoSeg} pedidos de Seguimiento sin gestionar`,
      porque: doc('seguimiento').porque,
      ruta: '/seguimiento',
      tono: 'normal',
    };
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
