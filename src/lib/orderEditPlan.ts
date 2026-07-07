// Cerebro puro del diálogo unificado "Edición de orden" (OrderEditorDialog):
// decide QUÉ llamadas al backend ejecutar y en qué orden según lo que la
// operadora cambió. Vive separado del componente para poder testearlo con la
// matriz completa de combinaciones.
//
// Los tres mecanismos (todos verificados en producción):
//  - 'update_full'  → edge dropi-update-order-full (PUT integration-key):
//                     datos del cliente + dirección. CONSERVA el ID del pedido.
//  - 'apply_edit'   → edge dropi-change-carrier mode apply_edit: recrea el
//                     pedido como el panel de Dropi (transportadora y/o líneas
//                     y/o valor en UNA sola recreación → ID NUEVO).
//  - 'apply_value'  → edge dropi-change-carrier mode apply_value: solo valor.
//                     Intenta primero el PUT directo que CONSERVA el ID — por
//                     eso se prefiere cuando lo único que cambió es el total.

export type EditStep = 'update_full' | 'apply_edit' | 'apply_value';

export interface EditFlags {
  /** Cambió algún dato del cliente (nombre/apellido/teléfono/depto/ciudad/dirección/email). */
  clientDirty: boolean;
  /** La transportadora seleccionada difiere de la actual (comparar por nombre normalizado). */
  carrierChanged: boolean;
  /** Cambió cantidad o precio de alguna línea de producto. */
  linesChanged: boolean;
  /** El total a recaudar difiere del valor actual del pedido. */
  valorChanged: boolean;
  /** Pedido con guía generada: transportadora/líneas/valor quedaron fijos. */
  hasGuia: boolean;
  /** Pedido ya gestionado (o.result): mismo bloqueo que la guía. */
  isManaged: boolean;
}

/**
 * Pasos a ejecutar EN ORDEN. Reglas:
 *  - Con guía o gestionado: solo datos del cliente (si cambiaron).
 *  - Datos del cliente SIEMPRE PRIMERO: la recreación posterior lee el pedido
 *    fresco desde Dropi (v2) / la fila local, así la orden nueva nace con los
 *    datos corregidos.
 *  - Transportadora o líneas → UNA sola recreación (apply_edit) que arrastra
 *    también el valor si cambió — nunca dos recreaciones encadenadas.
 *  - Solo valor → apply_value (conserva el camino PUT que mantiene el ID).
 */
export function buildUpdatePlan(f: EditFlags): EditStep[] {
  if (f.hasGuia || f.isManaged) {
    return f.clientDirty ? ['update_full'] : [];
  }
  const steps: EditStep[] = [];
  if (f.clientDirty) steps.push('update_full');
  if (f.carrierChanged || f.linesChanged) steps.push('apply_edit');
  else if (f.valorChanged) steps.push('apply_value');
  return steps;
}

/** Línea de producto editable en el diálogo (viene del quote extendido). */
export interface EditableLine {
  dropiId: number;
  quantity: number;
  price: number;
  name?: string;
}

/** ¿La operadora tocó cantidad o precio de alguna línea? Compara contra las
 *  líneas que devolvió el quote (mismo set de dropiIds por diseño de la UI). */
export function linesDirty(quoted: EditableLine[], edited: EditableLine[]): boolean {
  if (quoted.length !== edited.length) return true;
  const byId = new Map(quoted.map(l => [l.dropiId, l]));
  for (const e of edited) {
    const q = byId.get(e.dropiId);
    if (!q) return true;
    if (q.quantity !== e.quantity) return true;
    if (Math.abs(q.price - e.price) > 0.001) return true;
  }
  return false;
}

/** Redondeo por país — espejo client-side de roundMoney del edge:
 *  EC cobra en USD con centavos; CO en pesos enteros. */
export function roundMoneyClient(n: number, countryCode?: string | null): number {
  const f = countryCode === 'EC' ? 100 : 1;
  return Math.round(n * f) / f;
}

/**
 * Total a recaudar final: el override manual manda si es válido (>0);
 * si no, la suma de las líneas. Sin líneas ni override válido → fallback.
 */
export function deriveTotal(
  lines: EditableLine[] | null,
  override: number | null,
  countryCode?: string | null,
  fallback = 0,
): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return roundMoneyClient(override, countryCode);
  }
  if (lines && lines.length > 0) {
    return roundMoneyClient(lines.reduce((s, l) => s + l.price * l.quantity, 0), countryCode);
  }
  return roundMoneyClient(fallback, countryCode);
}
