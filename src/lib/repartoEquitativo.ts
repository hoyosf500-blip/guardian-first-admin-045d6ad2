// src/lib/repartoEquitativo.ts
//
// Reparto de la cola de Seguimiento entre las asesoras.
//
// ── Pieza C del protocolo del turno ─────────────────────────────────────────
// El dueño: *"cómo organizar a mis colaboradores… que sepa qué hacer sin yo
// estar encima"*. Hoy no se puede: el modelo es pool compartido, todas ven
// todo, y la propiedad se deduce DESPUÉS de quién tocó el pedido. Sirve para
// una asesora sola; para coordinar un equipo significa que no hay a quién
// reclamarle un pedido que nadie tocó.
//
// ── ⛔ LA LECCIÓN QUE NO SE PUEDE REPETIR ───────────────────────────────────
// Esto YA se intentó y se apagó el 24-may-2026
// (`20260524120000_disable_auto_assign_operator.sql`). El trigger
// `assign_order_to_operator` estampaba un dueño en CADA pedido al nacer, y la
// pantalla lo trataba como CANDADO: *"Atendido por X — no puedes ejecutar
// acciones"*. Resultado: todo pedido tenía dueño, casi ninguno tenía trabajo
// hecho, y las demás quedaban bloqueadas.
//
// El error no fue asignar. Fue (a) asignar al NACER, cuando todavía no hay
// nada que hacer, y (b) convertir la etiqueta en un candado.
//
// Este reparto corrige las dos cosas:
//   · Reparte **la cola accionable de HOY**, no los pedidos al nacer.
//   · La asignación es una ETIQUETA DE RESPONSABILIDAD, nunca un candado.
//     Cualquiera puede seguir gestionando cualquier pedido. La etiqueta
//     contesta dos preguntas que hoy no tienen respuesta: para la asesora,
//     "¿qué es mío?"; para el dueño, "¿quién tenía que haber hecho esto?".
//
// ── Otra trampa esquivada ───────────────────────────────────────────────────
// NO se reusa `orders.assigned_to`: el cron `release-stale-seg-assignments`
// (cada hora) lo pone en NULL cuando el asignado no dejó un touchpoint en 48 h
// — o sea, borraría justo los pedidos que nadie tocó, que son EXACTAMENTE los
// que hay que rastrear. Va en tabla propia.
//
// Puro: sin red, sin React, sin reloj.

export interface PedidoAReparto {
  /** `orders.id`. */
  orderId: string;
}

export interface AsignacionExistente {
  orderId: string;
  operatorId: string;
}

export interface RepartoInput {
  /** Cola accionable YA ORDENADA POR URGENCIA (la más urgente primero). */
  pedidos: PedidoAReparto[];
  /** Asesoras entre las que repartir. El orden se respeta para desempatar. */
  operadores: string[];
  /** Lo que YA está asignado hoy. No se toca: robarle un pedido a quien ya lo
   *  empezó es peor que un reparto desparejo. */
  yaAsignados?: AsignacionExistente[];
  /**
   * Carga de partida por operadora: lo que le FALTA, no lo que le tocó.
   *
   * ── Por qué hace falta (pedido del dueño, 3-sep-2026) ──────────────────────
   * Textual: *"si una asesora terminó, que se le carguen más pedidos"*. Sin
   * esto no puede pasar. La carga por defecto cuenta pedidos **asignados**, así
   * que Marcela —que ya despachó sus 40— y Johana —que no tocó ninguno de sus
   * 40— pesan igual: 40 y 40. Lo que entra a media mañana se parte por mitades
   * y la que está libre queda esperando mientras la otra se hunde.
   *
   * Pasando `sinTocar` (lo calcula `turnoDelEquipo.ts`) Marcela entra con 0 y
   * se lleva el trabajo nuevo, que es exactamente lo que se pidió.
   *
   * ⛔ TODO O NADA. Quien lo arma tiene que pasar un número por CADA operadora
   * de `operadores`, o no pasar el mapa. `sinTocar` es `number | null` —
   * `turnoDelEquipo.ts` es explícito en que *"cero nunca sustituye a 'no se
   * pudo medir'"*—, y un `null` colado como 0 le apilaría todo el trabajo nuevo
   * justo a la persona que no se pudo medir. Ante la duda: no se pasa el mapa y
   * se reparte como siempre.
   *
   * Ausente ⇒ comportamiento idéntico al de antes de existir este parámetro.
   */
  cargaBase?: Map<string, number>;
}

export interface RepartoResultado {
  /** Solo las asignaciones NUEVAS. Las existentes no se reescriben. */
  nuevas: AsignacionExistente[];
  /** Carga final por operador (existentes + nuevas), para poder mostrarla. */
  cargaFinal: Map<string, number>;
  /** Pedidos que quedaron sin asignar y por qué. */
  sinAsignar: number;
  motivoSinAsignar: 'sin_operadores' | null;
}

/**
 * Reparte la cola entre las asesoras equilibrando la CARGA, no en round-robin
 * ciego.
 *
 * Por qué por carga y no round-robin: el reparto se puede correr más de una vez
 * al día (entra trabajo nuevo, se suma alguien al turno). Un round-robin desde
 * cero reasignaría todo; equilibrar por carga respeta lo ya asignado y solo
 * reparte lo que falta, dejando a todas parejas igual.
 *
 * Y se recorre la cola EN ORDEN DE URGENCIA: así cada asesora recibe una mezcla
 * parecida de urgente y no urgente, en vez de que una cargue con todo lo que
 * vence hoy.
 *
 * Determinista: mismas entradas → mismo resultado. Los empates de carga se
 * resuelven por el orden de `operadores`, nunca al azar — un reparto que cambia
 * solo entre dos corridas es imposible de auditar.
 */
export function repartirCola(input: RepartoInput): RepartoResultado {
  const { pedidos, operadores } = input;
  const yaAsignados = input.yaAsignados ?? [];

  // `cargaBase` solo se acepta si trae un número usable para CADA operadora.
  // Un hueco haría entrar a esa persona con 0 y se llevaría todo lo nuevo —
  // convirtiendo un "no se pudo medir" en el peor reparto posible.
  const baseCompleta =
    input.cargaBase != null &&
    operadores.every((op) => {
      const v = input.cargaBase!.get(op);
      return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    });

  const carga = new Map<string, number>();
  for (const op of operadores) carga.set(op, baseCompleta ? input.cargaBase!.get(op)! : 0);

  const dueñoDe = new Map<string, string>();
  for (const a of yaAsignados) {
    dueñoDe.set(a.orderId, a.operatorId);
    // Un asignado a alguien que YA NO está en la lista (se fue del turno) sigue
    // contando como suyo — no se le roba —, pero no suma carga a nadie de la
    // lista actual, así el resto no queda penalizado por su ausencia.
    //
    // Con `cargaBase` NO se vuelve a sumar: el número que llega ya es "lo que le
    // falta", y sumarle encima los asignados contaría dos veces el mismo pedido.
    if (!baseCompleta && carga.has(a.operatorId)) {
      carga.set(a.operatorId, (carga.get(a.operatorId) ?? 0) + 1);
    }
  }

  const pendientes = pedidos.filter((p) => !dueñoDe.has(p.orderId));

  if (operadores.length === 0) {
    return {
      nuevas: [],
      cargaFinal: carga,
      sinAsignar: pendientes.length,
      motivoSinAsignar: pendientes.length > 0 ? 'sin_operadores' : null,
    };
  }

  const nuevas: AsignacionExistente[] = [];
  for (const p of pendientes) {
    // El de menor carga; empate → el primero en `operadores`.
    let elegido = operadores[0];
    let min = carga.get(elegido) ?? 0;
    for (const op of operadores) {
      const c = carga.get(op) ?? 0;
      if (c < min) { min = c; elegido = op; }
    }
    carga.set(elegido, min + 1);
    nuevas.push({ orderId: p.orderId, operatorId: elegido });
  }

  return { nuevas, cargaFinal: carga, sinAsignar: 0, motivoSinAsignar: null };
}

/**
 * ¿Qué tan parejo quedó? Diferencia entre quien más y quien menos tiene.
 * Con un reparto limpio nunca debería pasar de 1.
 */
export function desbalance(cargaFinal: Map<string, number>): number {
  if (cargaFinal.size === 0) return 0;
  const v = [...cargaFinal.values()];
  return Math.max(...v) - Math.min(...v);
}
