// src/lib/cierreSeguimiento.ts
//
// El cierre del día de Seguimiento: "¿quedó en cero, y si no, por qué?"
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// `ClosingReportDialog` existe SOLO en `/confirmar`. O sea: el trabajo de
// Confirmar tiene un final definido —la asesora dice "terminé" y queda escrito
// qué pasó— y el de Seguimiento no tiene ninguno. Un trabajo sin final es un
// trabajo que nadie declara terminado y que, por lo tanto, nadie declara
// incompleto tampoco. Simplemente se apaga la computadora.
//
// La regla del dueño para esta pantalla es "Seguimiento se deja en 0". El
// cierre la vuelve verificable: **o queda en cero, o queda escrito el motivo**.
// Esas dos son las únicas salidas.
//
// ── Lo que este cierre NO es ────────────────────────────────────────────────
// No es un permiso ni un candado: nadie queda bloqueado por no cerrar, igual
// que la asignación es etiqueta y no candado. Lo que hace es dejar CONSTANCIA,
// y esa constancia es lo que le permite al dueño dejar de preguntar. Si mañana
// alguien lo convierte en un requisito para salir, repite el error de
// `OpeningReportGate`, que bloqueaba la pantalla y terminó desmontado.
//
// ── La regla que no se negocia ──────────────────────────────────────────────
// **Si no se pudo medir, no se cierra.** Cuando la lectura de gestiones del día
// falla, "0 gestionados" y "no se pudo leer" se ven idénticos — y firmar un
// cierre que dice "no trabajé nada" por una query caída es peor que no cerrar.
// Misma regla que `turnoDelEquipo` y que el hero de Seguimiento.
//
// Puro: sin red, sin React, sin reloj.

export interface EstadoCierre {
  /** Tamaño de la cola accionable de hoy. */
  cola: number;
  /** Cuántos de esos ya se gestionaron hoy. `null` = no se pudo medir. */
  gestionados: number | null;
}

export type MotivoDelCierre =
  /** Cola en cero: el día se cumplió, no hay nada que explicar. */
  | 'en_cero'
  /** Quedaron pendientes: hace falta escribir por qué. */
  | 'con_pendientes'
  /** La lectura falló: no se puede firmar un número que no se conoce. */
  | 'no_medible';

export interface DecisionCierre {
  tipo: MotivoDelCierre;
  /** Los que quedaron sin gestionar. `null` = no se pudo medir. */
  faltan: number | null;
  /** ¿Se puede enviar el cierre ahora? */
  puedeCerrar: boolean;
  /** ¿Hay que exigir un motivo escrito? */
  exigeMotivo: boolean;
  /** Qué se le dice a la persona, en su idioma. */
  titulo: string;
  detalle: string;
}

/** Un motivo tiene que decir algo. "ok", "listo" y "." no explican nada. */
export const MOTIVO_MIN_CHARS = 15;

export function decidirCierre(e: EstadoCierre): DecisionCierre {
  if (e.gestionados === null) {
    return {
      tipo: 'no_medible',
      faltan: null,
      puedeCerrar: false,
      exigeMotivo: false,
      titulo: 'No se pudo leer lo trabajado hoy',
      detalle:
        'La lectura de gestiones falló, así que no se sabe cuántos pedidos quedaron. Firmar un cierre con estos números diría algo que nadie midió. Recargá la pantalla e intentá de nuevo.',
    };
  }

  const faltan = Math.max(e.cola - e.gestionados, 0);

  if (faltan === 0) {
    return {
      tipo: 'en_cero',
      faltan: 0,
      puedeCerrar: true,
      exigeMotivo: false,
      titulo: 'Seguimiento quedó en cero',
      detalle:
        e.cola === 0
          ? 'Hoy no entró trabajo accionable a Seguimiento.'
          : `Se gestionaron los ${e.cola} pedidos que vencían hoy.`,
    };
  }

  return {
    tipo: 'con_pendientes',
    faltan,
    puedeCerrar: true,
    exigeMotivo: true,
    titulo: `Quedan ${faltan} sin gestionar`,
    detalle:
      'Escribí qué pasó. No es un reproche: es la única forma de que mañana alguien sepa dónde retomar, y de que un problema que se repite se pueda ver.',
  };
}

/** ¿El motivo escrito alcanza para enviar? */
export function motivoSuficiente(motivo: string, exige: boolean): boolean {
  if (!exige) return true;
  return motivo.trim().length >= MOTIVO_MIN_CHARS;
}
