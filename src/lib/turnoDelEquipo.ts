// src/lib/turnoDelEquipo.ts
//
// La vista de dueño: ¿cómo va el turno de mi equipo HOY?
//
// ── Pieza D del protocolo del turno ─────────────────────────────────────────
// El dueño pidió tres cosas y nada más: cuánto quedó sin tocar, quién estuvo
// quieto con trabajo encima, y cuántos se perdieron por demora. Esta librería
// contesta la primera y la tercera con lo que ya está cargado en pantalla; la
// segunda vive en `/admin → Productividad`, donde ya se mide la jornada.
//
// Contexto de por qué hace falta: `SegCounterBar.tsx` esconde el contador de la
// cola para `isAdmin || isOwnerOfActive`. O sea, **el dueño ve MENOS que su
// equipo** — fue literalmente su queja ("yo como dueño no lo entiendo"). Alguien
// decidió que el dueño no trabaja la cola, así que no necesita el contador. Pero
// él no quiere trabajarla: quiere ver si la están trabajando.
//
// ── La regla que no se negocia ──────────────────────────────────────────────
// **Cero nunca sustituye a "no se pudo medir".** Si la lectura de las gestiones
// del día falló, `tocados` y `sinTocar` vienen en `null`, no en 0. Un 0 acá se
// lee como "no trabajaron" y el dueño le reclama a su equipo por un dato que
// nunca se pudo leer. Es la misma regla que ya aplica `coverageSegError` en el
// hero de Seguimiento.
//
// Puro: sin red, sin React, sin reloj.

import type { OrderData } from './orderUtils';

export interface FilaAsesora {
  operatorId: string;
  /** Pedidos accionables que le tocaron hoy. */
  asignados: number;
  /** De los suyos, cuántos tienen gestión de HOY. `null` = no se pudo medir. */
  tocados: number | null;
  /** Los suyos sin gestión hoy. `null` = no se pudo medir. */
  sinTocar: number | null;
}

export interface TurnoDelEquipo {
  /** Una fila por asesora con carga, ordenada por lo que falta (peor primero). */
  filas: FilaAsesora[];
  /** Accionables SIN dueño hoy: nadie los va a reclamar porque no son de nadie. */
  sinDueno: number;
  /** Tamaño de la cola accionable de hoy. */
  totalAccionable: number;
  /** Accionables con gestión de hoy, de cualquiera. `null` = no se pudo medir. */
  tocadosTotal: number | null;
  /** false = la lectura de gestiones falló; los conteos de trabajo son null. */
  medible: boolean;
}

export interface TurnoDelEquipoInput {
  /** SOLO los pedidos accionables de hoy (filtrados por `esAccionable`). */
  accionables: readonly OrderData[];
  /** order_id → operator_id del día (`useSegAsignaciones`). */
  asignaciones: Map<string, string>;
  /** phone → gestión de hoy del equipo (`gestionSegPorTelefono`). */
  gestionEquipo: Map<string, { ultimoPor: string | null }> | null | undefined;
  /** Asesoras del turno. Se listan aunque tengan 0 — un cero visible es
   *  información ("no le tocó nada"); una fila ausente parece un olvido. */
  operadores: readonly string[];
  /** false si la query de gestiones del día falló. Ver la regla de arriba. */
  gestionCargada: boolean;
}

export function turnoDelEquipo(input: TurnoDelEquipoInput): TurnoDelEquipo {
  const { accionables, asignaciones, gestionEquipo, operadores, gestionCargada } = input;

  const medible = gestionCargada;
  const totalAccionable = accionables.length;

  const asignadosPor = new Map<string, number>();
  const tocadosPor = new Map<string, number>();
  for (const op of operadores) {
    asignadosPor.set(op, 0);
    tocadosPor.set(op, 0);
  }

  let sinDueno = 0;
  let tocadosTotal = 0;

  for (const o of accionables) {
    const dueno = o.dbId ? asignaciones.get(o.dbId) : undefined;
    // Gestión de hoy: alcanza con que la haya tocado CUALQUIERA. Si la trabajó
    // una compañera, el pedido está atendido — no es una deuda del dueño
    // nominal. Lo que se mide es si el trabajo se hizo, no quién lo hizo.
    const tocado = Boolean(o.phone && gestionEquipo?.get(o.phone)?.ultimoPor);

    if (tocado) tocadosTotal++;

    if (!dueno) {
      sinDueno++;
      continue;
    }
    asignadosPor.set(dueno, (asignadosPor.get(dueno) ?? 0) + 1);
    if (tocado) tocadosPor.set(dueno, (tocadosPor.get(dueno) ?? 0) + 1);
  }

  const filas: FilaAsesora[] = [...asignadosPor.entries()].map(([operatorId, asignados]) => {
    const tocados = medible ? (tocadosPor.get(operatorId) ?? 0) : null;
    return {
      operatorId,
      asignados,
      tocados,
      sinTocar: tocados === null ? null : Math.max(asignados - tocados, 0),
    };
  });

  // Peor primero: lo que falta es lo que hay que mirar. Empate por id para que
  // las filas no bailen entre refrescos de realtime.
  filas.sort((a, b) =>
    (b.sinTocar ?? -1) - (a.sinTocar ?? -1) ||
    b.asignados - a.asignados ||
    a.operatorId.localeCompare(b.operatorId));

  return {
    filas,
    sinDueno,
    totalAccionable,
    tocadosTotal: medible ? tocadosTotal : null,
    medible,
  };
}
