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

/** Cuenta los pedidos de `segData` que caen en una lista SLA por su slug. */
function contarLista(segData: OrderData[], slug: SegListSlug): number {
  const def = findSegList(slug);
  if (!def) return 0; // slug renombrado → 0, nunca una excepción en pantalla
  let n = 0;
  for (const o of segData) if (def.matches(o)) n++;
  return n;
}

const rutaSeg = (slug: SegListSlug) => `/seguimiento?lista=${slug}`;

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
}

/**
 * Devuelve el ÚNICO escalón que toca ahora. No una lista de pendientes: una
 * instrucción. Si la persona tiene que elegir entre pantallas va a elegir la
 * más cómoda, y la más cómoda nunca es la que vence.
 */
export function siguienteAccion(input: SiguienteAccionInput): SiguienteAccion {
  const { workQueue, novedadesQueue, segData, segCargado = true } = input;

  // ── 1. Novedades ──────────────────────────────────────────────────
  const novedades = novedadesQueue.length;
  if (novedades > 0) {
    return {
      key: 'novedades',
      cuantos: novedades,
      titulo: novedades === 1 ? 'Resolvé la novedad abierta' : `Resolvé las ${novedades} novedades abiertas`,
      etiqueta: novedades === 1 ? '1 novedad abierta' : `${novedades} novedades abiertas`,
      porque: 'La transportadora tiene el paquete detenido esperando respuesta.',
      ruta: '/novedades',
      tono: 'urgente',
    };
  }

  // ── 2. Agencia con reloj ──────────────────────────────────────────
  const agencia = segCargado ? contarLista(segData, 'agencia_2d') : 0;
  if (agencia > 0) {
    return {
      key: 'agencia',
      cuantos: agencia,
      titulo: agencia === 1
        ? 'Avisá al cliente que su paquete está en la agencia'
        : `Avisá a ${agencia} clientes que su paquete está en la agencia`,
      etiqueta: agencia === 1 ? '1 paquete esperando en la agencia' : `${agencia} paquetes esperando en la agencia`,
      porque: 'La transportadora lo guarda unos días y después lo devuelve sin avisar.',
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
      porque: 'Un pedido sin confirmar a los 4 días se cancela solo.',
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
      porque: 'Llevan +72 h sin moverse. Acá se le reclama a la transportadora, no al cliente.',
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
      porque: 'Cancelado no es perdido: en julio, 32 de 49 pedidos re-emitidos terminaron entregados.',
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
      porque: 'Indemnizaciones vencidas, pendientes de guía y reparto.',
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
