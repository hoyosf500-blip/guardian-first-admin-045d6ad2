// ¿Vale la pena frenar un segundo antes de cancelar ESTE pedido?
//
// ── El pedido del dueño (4-sep-2026), textual ───────────────────────────────
// *"El candado para cancelar sí: que les salga tipo alerta 'este cliente llegó
// hoy y lo vas a cancelar', o 'este cliente solo lleva 2 días y lo vas a
// cancelar, y queda en el registro, ¿estás seguro?'. Algo que le meta
// psicología a la operadora y no cancele por cancelar."*
//
// Y la medición que lo motivó (septiembre, Ecuador): el equipo decía que le
// daba "al menos 5 días de gestión" a cada pedido antes de cancelarlo. La
// mediana real entre el pedido y la cancelación fue de 5 HORAS; 24 de 36
// cancelaciones no tenían ni una gestión previa registrada; ninguna pasó de
// los 5 días.
//
// ── Lo que este archivo NO hace, a propósito ────────────────────────────────
// ⛔ NO bloquea. El dueño fue explícito: "no contesta" son intentos de
// confirmación y no se pueden trabar. Esto es una pregunta con los datos
// delante — la edad del pedido, cuántas veces se lo llamó, y que la
// cancelación queda a su nombre — y la salida de cancelar sigue existiendo.
// ⛔ NO se pregunta dos veces por el mismo pedido en la misma sesión: repreguntar
// enseña a apretar "sí" sin leer (misma regla que `confirmarSinDuplicar`).
// ⛔ Un pedido que ya lleva varios días trabajado NO se frena: ahí la asesora
// ya hizo el trabajo y la pregunta sería un estorbo.
//
// Puro: sin red, sin React. El reloj se recibe por parámetro.

import { esIntentoDeLlamada, type AttemptRow } from './attemptFormat';

/** A partir de esta edad ya no se pregunta: el pedido fue trabajado. */
export const DIAS_SIN_PREGUNTA = 3;
/** Los "no contesta" que la operación exige antes de darlo por perdido. */
export const INTENTOS_ESPERADOS = 3;

/** Motivos que no dependen de insistir más: no tiene sentido pedir otra vuelta. */
const MOTIVOS_OBJETIVOS = new Set(['Duplicado', 'Teléfono malo', 'No llega a su zona']);

export interface AvisoAntesDeCancelar {
  /** true = mostrar la pregunta ANTES de cancelar. */
  frena: boolean;
  titulo: string;
  /** Una línea por dato. La última siempre es la del registro. */
  lineas: string[];
  /** Cómo se llama el botón que NO cancela. */
  alternativa: string;
}

const SIN_AVISO: AvisoAntesDeCancelar = { frena: false, titulo: '', lineas: [], alternativa: '' };

export interface DatosParaAviso {
  /** `createdAt` ISO de la fila, o `fecha` del pedido (DD/MM/YYYY · YYYY-MM-DD). */
  createdAt?: string | null;
  fecha?: string | null;
  /** Motivo canónico elegido (valor de CANCEL_REASONS). */
  motivo: string;
  /** Filas de order_results de ESTE pedido (lo que devuelve useOrderAttempts). */
  intentos: AttemptRow[];
  /** Si el historial no se pudo leer, no afirmamos "cero intentos". */
  intentosNoLeidos?: boolean;
  /** Ya se le preguntó por este pedido en esta sesión. */
  yaDecidio?: boolean;
  ahora: Date;
}

function parseCuando(createdAt?: string | null, fecha?: string | null): Date | null {
  if (createdAt) {
    const d = new Date(createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const s = (fecha || '').trim();
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (dmy) {
    let y = parseInt(dmy[3], 10);
    if (y < 100) y += 2000;
    const d = new Date(Date.UTC(y, parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10)));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  return null;
}

/** "llegó hoy, hace 5 h" · "lleva 2 días" */
export function describirEdad(cuando: Date, ahora: Date): { dias: number; texto: string } {
  const ms = Math.max(0, ahora.getTime() - cuando.getTime());
  const horas = Math.floor(ms / 3_600_000);
  const dias = Math.floor(ms / 86_400_000);
  if (dias === 0) {
    if (horas < 1) return { dias, texto: 'llegó hace menos de una hora' };
    return { dias, texto: `llegó hoy, hace ${horas} h` };
  }
  if (dias === 1) return { dias, texto: 'llegó ayer' };
  return { dias, texto: `lleva solo ${dias} días` };
}

export function avisoAntesDeCancelar(d: DatosParaAviso): AvisoAntesDeCancelar {
  if (d.yaDecidio) return SIN_AVISO;
  if (MOTIVOS_OBJETIVOS.has(d.motivo)) return SIN_AVISO;

  const cuando = parseCuando(d.createdAt, d.fecha);
  // Sin fecha no sabemos la edad: no inventamos "llegó hoy". Solo se frena si
  // además faltan intentos, que es un dato que sí tenemos.
  const edad = cuando ? describirEdad(cuando, d.ahora) : null;
  if (edad && edad.dias >= DIAS_SIN_PREGUNTA) return SIN_AVISO;

  const llamadas = d.intentos.filter((a) => esIntentoDeLlamada(a.result));
  const sinRespuesta = llamadas.filter((a) => a.result === 'noresp').length;

  const lineas: string[] = [];
  if (edad) lineas.push(`Este pedido ${edad.texto}.`);
  if (d.intentosNoLeidos) {
    lineas.push('No se pudo leer cuántas veces se lo llamó.');
  } else if (llamadas.length === 0) {
    lineas.push('No hay ni un intento de llamada registrado.');
  } else {
    lineas.push(
      sinRespuesta === 1
        ? `Se lo llamó 1 vez sin respuesta (la operación pide ${INTENTOS_ESPERADOS}).`
        : `Se lo llamó ${sinRespuesta} veces sin respuesta` +
            (sinRespuesta < INTENTOS_ESPERADOS ? ` (la operación pide ${INTENTOS_ESPERADOS}).` : '.'),
    );
  }

  // Sin fecha y con los intentos completos, no hay nada que preguntar.
  if (!edad && !d.intentosNoLeidos && sinRespuesta >= INTENTOS_ESPERADOS) return SIN_AVISO;

  lineas.push(`La cancelación queda registrada a tu nombre con el motivo «${d.motivo}».`);

  const titulo = d.motivo === 'No contesta'
    ? '¿Lo cancelás por no contestar?'
    : '¿Seguro que lo cancelás?';

  return {
    frena: true,
    titulo,
    lineas,
    alternativa: d.motivo === 'No contesta' ? 'Volver a intentarlo' : 'Intentar rescatarlo',
  };
}
