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

// ── ⛔ EL TEXTO DEL BOTÓN ES LA SEÑAL — y cambiarlo la apaga ────────────────
// Incidente del 27-ago-2026, medido el 29: en el panel de ImporChat se cambió
// la plantilla de confirmación (`confirmacion_pedido_k1` → `confirmacion_datos_v1`,
// que muestra ciudad/provincia/dirección para bajar devoluciones). La plantilla
// nueva es mejor, pero su botón dice **"Sí, está correcto"**, no "CONFIRMAR
// PEDIDO" — y acá se buscaba la palabra "CONFIRMAR". Resultado en producción:
//
//     26-ago: 25 de 43 `confirmado` (58%)
//     27-ago:  1 de 45  (2%)   ← se cableó la plantilla nueva
//     28-ago:  0 de 41  (0%)
//
// Cero. Verificado leyendo chats reales: Roxana Mora (6749394, 6748452) y
// Seimon Tirado (6755681) APRETARON "Sí, está correcto" y Guardian los archivó
// como `tibio` = "escribió pero nunca apretó el botón · 34% cancela · llamalo".
// La asesora estuvo dos días llamando a gente que ya había confirmado, mientras
// el mejor predictor que tiene esta operación (10% vs 34% de cancelación)
// marcaba cero para todo el mundo.
//
// De ahí las tres listas de abajo: se reconocen los botones de TODAS las
// plantillas cableadas, no los de una. Y `esBotonConocido` existe para que la
// próxima vez el sync AVISE en vez de quedarse ciego — ver `botonesDesconocidos`
// en `importchat-sync`. Cablear una plantilla nueva sin agregar su botón acá no
// rompe nada visible: simplemente deja de haber confirmados, que es la falla
// más cara que puede tener este archivo.

/** Botones que SÍ son "confirmo mi pedido", uno por plantilla cableada. */
export const BOTONES_CONFIRMAR = [
  "CONFIRMAR PEDIDO",   // confirmacion_pedido_k1 — hasta el 27-ago-2026
  "SI, ESTA CORRECTO",  // confirmacion_datos_v1  — desde el 27-ago-2026
] as const;
/** @deprecated Quedó por compatibilidad; la lista de arriba es la fuente. */
export const BOTON_CONFIRMAR = BOTONES_CONFIRMAR[0];

/** Botones que JAMÁS pueden leerse como una confirmación de pedido.
 *
 *  Se miran ANTES que los de confirmar, y ese orden es la defensa: por más que
 *  alguien afloje el matcher de abajo, nada de esta lista puede colarse como un
 *  "sí". Es la barrera contra el incidente del 27-29 de agosto de 2026, cuando
 *  el bot dio por confirmado lo que no lo estaba y generó guías solas.
 *
 *  1. Los DOS primeros son el otro botón de las plantillas de confirmación:
 *     los que apretaron "ACTUALIZAR INFORMACIÓN" cancelaron 42,9% (n=14) — del
 *     lado malo.
 *  2. "CONFIRMO RECEPCIÓN" NO es confirmar el pedido, y por eso está acá y no
 *     en `BOTONES_CONFIRMAR`. Medido el 30-ago-2026: `importchat-sync` lo venía
 *     reportando como desconocido ×26 por corrida. Su plantilla es el aviso de
 *     NOVEDAD que manda Dropi ("Enviado por Dropi Status … conforme a la ley 67
 *     del 2022 … necesitamos programar un nuevo intento de entrega"), y sus dos
 *     botones son "Confirmo recepción" / "Reprogramar entrega". O sea: el
 *     cliente se compromete a recibir un paquete que YA salió, con guía puesta.
 *     Meterlo en la lista de confirmar habría marcado como "confirmado para
 *     despacho" a pedidos en novedad — el error de 2026 otra vez, al revés.
 *     Ojo: la red de seguridad de abajo (`includes("CONFIRMAR")`) NO lo agarra,
 *     porque "CONFIRMO" no contiene "CONFIRMAR".
 *  3. "CANCELAR PEDIDO" es un rechazo explícito. Hoy solo sirve para que el
 *     detector de ceguera no lo cante como botón nuevo; como SEÑAL de
 *     cancelación todavía no se usa (ver el TODO más abajo).
 */
export const BOTONES_NO_CONFIRMAR = [
  "ACTUALIZAR INFORMACION", // confirmacion_pedido_k1
  "CORREGIR UN DATO",       // confirmacion_datos_v1
  "CONFIRMO RECEPCION",     // aviso de novedad de Dropi ("ley 67")
  "CANCELAR PEDIDO",        // rechazo explícito del cliente
] as const;

/* TODO (no se hizo acá a propósito): "CANCELAR PEDIDO" es la señal de
 * cancelación más limpia que existe — el cliente la dice él mismo, sin
 * interpretación. Hoy el modelo solo sabe "confirma / no confirma", así que
 * cablearla es una función nueva, no un ajuste de lista. Se anota para que no
 * se pierda: n=1 en la ventana medida el 30-ago-2026. */
/** @deprecated Ver `BOTONES_NO_CONFIRMAR`. */
export const BOTON_ACTUALIZAR = "ACTUALIZAR INFORMACIÓN";

/** Botones de las demás plantillas cableadas. No dicen nada de la confirmación;
 *  están acá para que un botón NUEVO se pueda distinguir de uno ya conocido. */
export const BOTONES_OTRAS_PLANTILLAS = [
  "SI, NECESITO LOS DATOS",  // retiro_agencia_v1
  "REPROGRAMAR ENTREGA",     // novedad_reprogramar_v1
  "SI, QUIERO RECIBIRLO",    // ultima_oportunidad_v1
  "SI, APARTENMELO",         // remarketing_v1
  "SI, REENVIENMELO",        // rescate_devolucion_v1
  "SI, ESTARE PENDIENTE",    // en_camino_hoy_v2
  "COORDINAR OTRA HORA",     // en_camino_hoy_v2
  "SI, CONTINUAR",           // seguimiento_reactivar_v1
  "YA NO ME INTERESA",       // seguimiento_reactivar_v1
] as const;

/** Plantillas que arrancan la confirmación. Sin una de ellas no hay botón que
 *  apretar, y exigirlo sería exigir algo que nunca se ofreció. */
export const PLANTILLAS_CONFIRMACION = [
  "confirmacion_pedido_k1",
  "confirmacion_datos_v1",
] as const;
/** @deprecated Ver `PLANTILLAS_CONFIRMACION`. */
export const PLANTILLA_CONFIRMACION = PLANTILLAS_CONFIRMACION[0];

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
  /** Si le llegó alguna de las plantillas que traen el botón. */
  recibioPlantilla: boolean;
  /**
   * Textos de botones que el cliente apretó y Guardian NO sabe leer.
   *
   * Vacío es lo normal. Con algo adentro significa que se cableó una plantilla
   * nueva en ImporChat y su botón todavía no está en las listas de arriba — o
   * sea, que la señal de confirmación puede estar apagada AHORA MISMO sin dar
   * ningún error. `importchat-sync` lo saca a `sync_logs` con el texto puesto.
   */
  botonesDesconocidos: string[];
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

/** Mayúsculas, SIN tildes y con los espacios colapsados. Las tildes se sacan a
 *  propósito: el botón vivo dice "Sí, está correcto" y ya cambió de acentuación
 *  una vez. Comparar con tildes es comparar contra la suerte. */
function limpio(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** ¿Este mensaje es el cliente apretando el botón de confirmar? */
export function esBotonConfirmar(m: MensajeChat): boolean {
  if (m.tipo !== "button") return false;
  const t = limpio(m.texto);
  // El "no" gana: "CORREGIR UN DATO" y "ACTUALIZAR INFORMACIÓN" son rechazos
  // aunque algún día compartan una palabra con un botón de confirmar.
  if (BOTONES_NO_CONFIRMAR.some((b) => t.includes(b))) return false;
  if (BOTONES_CONFIRMAR.some((b) => t.includes(b))) return true;
  // Red de seguridad para las variantes viejas ("Confirmar pedido ✅"): se
  // compara por "contiene" porque el export trae el texto tal cual lo definió
  // la plantilla. No alcanza para el botón nuevo — por eso existe la lista.
  return t.includes("CONFIRMAR");
}

/**
 * ¿Este botón es uno de los que Guardian sabe leer?
 *
 * Es el detector de "me quedé ciego": cuando alguien cablea una plantilla nueva
 * en ImporChat, su botón cae acá como desconocido y `importchat-sync` lo dice en
 * `sync_logs` (con el texto, para poder agregarlo arriba). Sin esto, cambiar una
 * plantilla apaga la señal de confirmación **sin un solo error** — que es
 * exactamente lo que pasó entre el 27 y el 29 de agosto de 2026.
 */
export function esBotonConocido(m: MensajeChat): boolean {
  if (m.tipo !== "button") return false;
  const t = limpio(m.texto);
  if (!t) return false;
  return (
    esBotonConfirmar(m) ||
    BOTONES_NO_CONFIRMAR.some((b) => t.includes(b)) ||
    BOTONES_OTRAS_PLANTILLAS.some((b) => t.includes(b))
  );
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
      botonesDesconocidos: [],
      mudo: false,
      riesgo: "sin_dato",
    };
  }

  const orden = [...ventana].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  const boton = orden.find(esBotonConfirmar) ?? null;
  const palabra = orden.find(esPalabraDelCliente) ?? null;
  const recibioPlantilla = orden.some(
    (m) => m.rol === "Propietario" && !!m.plantilla &&
      (PLANTILLAS_CONFIRMACION as readonly string[]).includes(m.plantilla),
  );
  const mudo = historial !== null && !historial.some(esPalabraDelCliente);
  const botonesDesconocidos = [
    ...new Set(
      orden
        .filter((m) => m.rol === "Cliente" && m.tipo === "button" && !esBotonConocido(m))
        .map((m) => (m.texto ?? "").trim())
        .filter(Boolean),
    ),
  ];

  return {
    apretoBotonAt: boton ? boton.fecha : null,
    clienteEscribioAt: palabra ? palabra.fecha : null,
    recibioPlantilla,
    botonesDesconocidos,
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

// ─────────────────────────────────────────────────────────────────────────────
// Actividad del chat: ¿le escribimos? ¿nos escribió? (24-ago-2026)
//
// Nació de: "hay 75 pedidos en oficina, me dicen que ya les escribieron —
// ¿cómo verifico yo eso?". La respuesta no puede ser el touchpoint que declara
// la asesora: tiene que salir de lo que ImporChat registró de verdad.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que la actividad del chat afirma de un cliente. Todo nullable: sin
 *  historial leído no se afirma nada (null = no medido, jamás "no escribió"). */
export interface ActividadChat {
  /** Último mensaje del NEGOCIO al cliente (excluye notificaciones internas
   *  y borrados). null con historial leído = NADIE le escribió jamás. */
  salienteAt: Date | null;
  /** Cómo fue ese último saliente. 'plantilla' = template; 'directo' = texto/
   *  imagen/audio/video/documento escrito en el chat. El export NO dice si lo
   *  mandó el bot o una asesora — esto registra el TIPO, que sí es un hecho. */
  salienteTipo: "plantilla" | "directo" | null;
  /** Último mensaje del CLIENTE (texto, botón, audio, foto, ubicación…). */
  entranteAt: Date | null;
}

/** Tipos de fila que NO son un mensaje real hacia el cliente. `notificacion`
 *  es tráfico interno ("Te has asignado este chat"); `revoke` es un borrado. */
export const TIPOS_NO_MENSAJE = new Set(["notificacion", "revoke"]);

/**
 * Deriva la actividad del chat sobre el historial COMPLETO.
 *
 * A diferencia de `derivarSenal` (que trabaja la ventana del pedido), acá
 * interesa el crudo "¿cuándo fue la última vez que ALGUIEN de acá le habló?"
 * — la comparación contra la llegada a la agencia o la fecha de cancelación
 * la hace la pantalla, que es donde vive ese contexto.
 */
export function derivarActividadChat(historial: MensajeChat[] | null): ActividadChat {
  if (!historial || historial.length === 0) {
    return { salienteAt: null, salienteTipo: null, entranteAt: null };
  }
  let saliente: MensajeChat | null = null;
  let entrante: MensajeChat | null = null;
  for (const m of historial) {
    if (TIPOS_NO_MENSAJE.has(m.tipo)) continue;
    if (m.rol === "Propietario") {
      if (!saliente || m.fecha.getTime() > saliente.fecha.getTime()) saliente = m;
    } else if (m.rol === "Cliente") {
      if (!entrante || m.fecha.getTime() > entrante.fecha.getTime()) entrante = m;
    }
    // Otros roles (Notificacion (transferencia)…) no afirman nada.
  }
  return {
    salienteAt: saliente ? saliente.fecha : null,
    salienteTipo: saliente ? (saliente.tipo === "template" || saliente.plantilla ? "plantilla" : "directo") : null,
    entranteAt: entrante ? entrante.fecha : null,
  };
}
