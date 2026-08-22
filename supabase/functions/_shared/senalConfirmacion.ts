// La señal de confirmación de ImporChat: qué hizo el CLIENTE con el WhatsApp.
//
// ── Por qué existe ─────────────────────────────────────────────────────────
// Auditoría de agosto-2026 en Ecuador (765 pedidos ya resueltos, 213
// cancelados). De los 636 que recibieron la plantilla `confirmacion_pedido_k1`,
// lo que el cliente hace con su botón parte la población en dos mundos:
//
//   apretó "CONFIRMAR PEDIDO" ......  402 pedidos → 10,4% cancela
//   NO lo apretó ..................  220 pedidos → 57,7% cancela  ($3.928)
//
// z = −12,63, y aguanta en los cuatro productos por separado (Gafas 10,8/55,1 ·
// Freidora 13,6/72,7 · Drenaje 2,0/82,4 · Ejercitador 10,9/36,8). El botón
// agrega señal SOBRE "el cliente contestó": entre los que escribieron, apretar
// o no separa 12,4% de 41,6% (z = −6,08).
//
// Y llega a tiempo: la **mediana entre que sale la plantilla y que aprietan es
// de 0,0 h**. Aprietan al toque o no aprietan nunca. O sea que a los minutos de
// entrar el pedido ya se sabe en qué mitad cayó.
//
// ── Por qué NO se usa la antigüedad ────────────────────────────────────────
// Medido con el reloj real (el de Guardian está corrido, ver CLAUDE.md), la
// demora al primer contacto NO distingue nada dentro del primer día:
// <2 h → 19,3% · 2-6 h → 18,4% · 6-24 h → 20,1%. Recién a las +24 h sube a 36%
// y "nunca tocado" a 97%. Ordenar la cola por antigüedad es ordenar por ruido.
//
// ── Por qué esto vive acá y no en la edge function ─────────────────────────
// `vitest.config.ts` solo mira `src/**`, así que las pruebas de las edge
// functions nunca corren. El patrón del repo es dejar la lógica pura en
// `_shared/` y poner el test en `src/lib/` cruzando el límite.

/** Texto del botón de confirmación de la plantilla `confirmacion_pedido_k1`. */
export const BOTON_CONFIRMAR = "CONFIRMAR PEDIDO";
/** El otro botón de la misma plantilla. Apretarlo NO es confirmar: los que lo
 *  apretaron cancelaron 42,9% (n=14) — más cerca de los que no apretaron nada. */
export const BOTON_ACTUALIZAR = "ACTUALIZAR INFORMACIÓN";
/** Plantilla que arranca la confirmación. Sin ella no hay botón que apretar. */
export const PLANTILLA_CONFIRMACION = "confirmacion_pedido_k1";

/** Un mensaje de ImporChat, reducido a lo que esta señal necesita. */
export interface MensajeChat {
  /** 'Cliente' | 'Propietario' | 'Notificacion (transferencia)' */
  rol: string;
  /** 'text' | 'template' | 'button' | 'image' | 'audio' | ... */
  tipo: string;
  texto: string;
  /** Nombre de la plantilla, o null si es texto propio. */
  plantilla: string | null;
  /** Instante del mensaje. Hora LOCAL de ImporChat (Ecuador). */
  fecha: Date;
}

export interface SenalConfirmacion {
  /** Cuándo apretó "CONFIRMAR PEDIDO". null = no lo apretó (dentro de la ventana). */
  apretoBotonAt: Date | null;
  /** Cuándo escribió por primera vez (no cuenta apretar botones). */
  clienteEscribioAt: Date | null;
  /** Si le llegó la plantilla que trae el botón. */
  recibioPlantilla: boolean;
  /**
   * El cliente NUNCA escribió nada, en NINGÚN momento de la historia del chat.
   * Apretar un botón no cuenta como escribir.
   *
   * Ojo: se mide sobre el historial COMPLETO, no sobre la ventana del pedido —
   * de los 87 cancelados del grupo silencioso, 83 no habían escrito jamás, ni
   * antes ni después. Buscar solo en la ventana los daría por "no contestó
   * todavía" y perdería que a esa persona el chat directamente no le llega.
   */
  mudo: boolean;
  /** Riesgo derivado. Ver `clasificar`. */
  riesgo: NivelRiesgo;
}

/**
 * Los cuatro grupos medidos, ordenados por cuánto duelen.
 * `sin_dato` NO es un quinto grupo de riesgo: es la ausencia de medición, y
 * existe porque en esta operación **un cero nunca puede hacerse pasar por una
 * medición**. Un pedido sin conversación leída no es un pedido tranquilo.
 */
export type NivelRiesgo = "sin_dato" | "confirmado" | "tibio" | "frio" | "mudo";

export const RIESGO_DOC: Record<NivelRiesgo, { que: string; tasa: string; queHacer: string }> = {
  sin_dato: {
    que: "No se pudo leer la conversación",
    tasa: "—",
    queHacer: "Tratalo como si no supieras nada: no lo saltees por estar en blanco.",
  },
  confirmado: {
    que: "Apretó el botón de confirmar",
    tasa: "10% cancela",
    queHacer: "No hace falta llamarlo. Los que apretaron y ni escribieron cancelan 7,2%.",
  },
  tibio: {
    que: "Escribió, pero nunca apretó el botón",
    tasa: "34% cancela",
    queHacer: "Llamalo. Está enganchado pero no cerró: casi siempre es una duda del producto.",
  },
  frio: {
    que: "Alguna vez habló, pero con este pedido no hizo nada",
    tasa: "38% cancela",
    queHacer: "Escribile por el chat: ese cliente sí contesta, con este pedido todavía no.",
  },
  mudo: {
    que: "Nunca escribió nada por WhatsApp, jamás",
    tasa: "66% cancela",
    queHacer:
      "Teléfono o nada: el chat no sirve con esta persona. Es la mitad de todo lo que se cancela, y de los que nadie llamó se cancelaron TODOS.",
  },
};

function limpio(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

/** ¿Este mensaje es el cliente apretando el botón de confirmar? */
export function esBotonConfirmar(m: MensajeChat): boolean {
  // Se compara por "contiene" y no por igualdad: el export trae el texto del
  // botón tal cual lo definió la plantilla y ya cambió de acentuación una vez.
  return m.tipo === "button" && limpio(m.texto).includes("CONFIRMAR");
}

/** ¿El cliente escribió de verdad? Apretar un botón no es escribir. */
export function esPalabraDelCliente(m: MensajeChat): boolean {
  return m.rol === "Cliente" && m.tipo !== "button";
}

/**
 * Deriva la señal de un pedido.
 *
 * @param ventana   Mensajes del chat dentro de la ventana del pedido.
 * @param historial Historial COMPLETO del chat (para `mudo`). Si viene
 *                  `null` se asume que no se pudo leer y `mudo` queda en false
 *                  — nunca se afirma "nunca habló" sin haber mirado todo.
 */
export function derivarSenal(
  ventana: MensajeChat[] | null,
  historial: MensajeChat[] | null,
): SenalConfirmacion {
  // Sin conversación no hay señal. Devolver "confirmado" o "frio" acá sería
  // inventar: se devuelve `sin_dato` y la pantalla lo dice en la cara.
  if (!ventana) {
    return {
      apretoBotonAt: null,
      clienteEscribioAt: null,
      recibioPlantilla: false,
      mudo: false,
      riesgo: "sin_dato",
    };
  }

  const orden = [...ventana].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  const boton = orden.find(esBotonConfirmar) ?? null;
  const palabra = orden.find(esPalabraDelCliente) ?? null;
  const recibioPlantilla = orden.some(
    (m) => m.rol === "Propietario" && m.plantilla === PLANTILLA_CONFIRMACION,
  );
  const mudo = historial !== null && !historial.some(esPalabraDelCliente);

  return {
    apretoBotonAt: boton ? boton.fecha : null,
    clienteEscribioAt: palabra ? palabra.fecha : null,
    recibioPlantilla,
    mudo,
    riesgo: clasificar({ apreto: !!boton, escribio: !!palabra, recibioPlantilla, mudo }),
  };
}

/**
 * La escalera de riesgo. El orden de los `if` ES la decisión:
 *
 *  1. El botón manda sobre todo lo demás. Un pedido con botón apretado cancela
 *     10% aunque el cliente después discuta; sin botón cancela 58% aunque haya
 *     conversado largo. Preguntar primero por el botón no es un detalle.
 *  2. `mudo` va después del botón pero antes que todo lo demás. Medido sobre los
 *     765 resueltos de agosto, con ESTA clasificación exacta:
 *
 *        mudo        157 pedidos → 66,2% cancela  ($3.219 = la MITAD de todo
 *                                   lo que se pierde en el mes)
 *        frio         24 pedidos → 37,5%
 *        tibio       170 pedidos → 33,5%  ($1.787)
 *        confirmado  414 pedidos → 10,4%
 *
 *     Además de ser el peor, cambia el CANAL: a esa persona no le sirve otro
 *     WhatsApp, hay que llamarla por teléfono.
 *  3. Sin plantilla enviada no se puede exigir un botón que nunca se ofreció.
 *     Esos pedidos caen en `tibio`/`frio`/`mudo` según lo que haya hecho el
 *     cliente, nunca en `confirmado`.
 */
export function clasificar(x: {
  apreto: boolean;
  escribio: boolean;
  recibioPlantilla: boolean;
  mudo: boolean;
}): NivelRiesgo {
  if (x.apreto) return "confirmado";
  if (x.mudo) return "mudo";
  if (x.escribio) return "tibio";
  return "frio";
}

/** Orden para la cola de trabajo: primero lo que más se pierde si nadie lo toca. */
export const PRIORIDAD_RIESGO: Record<NivelRiesgo, number> = {
  mudo: 0,
  frio: 1,
  tibio: 2,
  sin_dato: 3,
  confirmado: 4,
};
