// Etiquetas por pedido (Fase 2b). Lógica PURA: el registro de etiquetas y la
// derivación de las AUTOMÁTICAS. Sin React, sin red.
//
// Dos clases:
//  - AUTO: las calcula el sistema con datos que YA existen (no dependen de que la
//    asesora acierte — norte del dueño "automático, evitar errores humanos"):
//      · datos_incompletos ← semáforo de dirección amarillo/rojo o faltan campos.
//      · no_contesta       ← llegó al tope de 3 intentos sin contestar.
//  - MANUAL: juicio humano, se guardan en la tabla order_labels:
//      · dificil    ← cliente problemático/dudoso.
//      · interesado ← confirmó interés pero no cerró.

export type LabelKey = 'datos_incompletos' | 'no_contesta' | 'dificil' | 'interesado';

export interface LabelDef {
  key: LabelKey;
  text: string;
  tone: 'yellow' | 'red' | 'orange' | 'green';
  auto: boolean; // true = derivada por el sistema; false = manual (order_labels)
}

export const LABELS: Record<LabelKey, LabelDef> = {
  datos_incompletos: { key: 'datos_incompletos', text: 'Datos incompletos', tone: 'yellow', auto: true },
  no_contesta:       { key: 'no_contesta',       text: 'No contesta',       tone: 'red',    auto: true },
  dificil:           { key: 'dificil',           text: 'Difícil',           tone: 'orange', auto: false },
  interesado:        { key: 'interesado',        text: 'Interesado',        tone: 'green',  auto: false },
};

/** Las etiquetas manuales disponibles para poner/quitar (juicio humano). */
export const MANUAL_LABELS: LabelDef[] = [LABELS.interesado, LABELS.dificil];

/** Cap de intentos N/R del día — mismo valor que MAX_DAILY_ATTEMPTS en OrderContext. */
export const NO_CONTESTA_ATTEMPTS = 3;

export interface AutoLabelInput {
  validationDecision?: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  missingFields?: string[] | null;
  norespCount?: number; // cantidad de "no contestó" registrados (hoy) para el pedido
}

/**
 * Deriva las etiquetas AUTOMÁTICAS de un pedido a partir de datos existentes.
 * Devuelve las keys en orden de prioridad visual (incompletos antes que no-contesta).
 */
export function deriveAutoLabels(o: AutoLabelInput): LabelKey[] {
  const out: LabelKey[] = [];
  const decision = o.validationDecision ?? null;
  const missing = Array.isArray(o.missingFields) ? o.missingFields : [];
  if (decision === 'yellow' || decision === 'red' || missing.length > 0) {
    out.push('datos_incompletos');
  }
  if ((o.norespCount ?? 0) >= NO_CONTESTA_ATTEMPTS) {
    out.push('no_contesta');
  }
  return out;
}
