// Semáforo de salud financiera — lógica pura de clasificación por umbral.
// Traído de la competencia (Wintrack): evalúa cada indicador del negocio
// contra estándares fijos del mercado COD y devuelve un color.
//
// Dos modos de comparación:
//   'menor' → menor es mejor (costo de producto, flete, devoluciones, pauta).
//              value <= green → verde ; value <= yellow → amarillo ; else rojo.
//   'mayor' → mayor es mejor (margen bruto, retorno de la pauta).
//              value >= green → verde ; value >= yellow → amarillo ; else rojo.
//
// Los umbrales se pasan explícitos por indicador (no hardcodeados acá) para que
// el componente sea la única fuente de verdad de las referencias de Wintrack.

export type HealthColor = 'green' | 'yellow' | 'red' | 'gray';
export type ThresholdKind = 'menor' | 'mayor';

/**
 * Clasifica un valor contra dos umbrales según el modo.
 * NO maneja el caso "sin dato" (gris) — eso lo decide el componente ANTES de
 * llamar acá (ej. pauta = 0). Esta función siempre devuelve verde/amarillo/rojo.
 */
export function evalIndicator(
  value: number,
  kind: ThresholdKind,
  green: number,
  yellow: number,
): 'green' | 'yellow' | 'red' {
  if (kind === 'menor') {
    if (value <= green) return 'green';
    if (value <= yellow) return 'yellow';
    return 'red';
  }
  // 'mayor' — mayor es mejor, lógica invertida.
  if (value >= green) return 'green';
  if (value >= yellow) return 'yellow';
  return 'red';
}

/** Veredicto textual corto por color (micro-frase de la celda). */
export function veredictoLabel(color: HealthColor): string {
  switch (color) {
    case 'green':  return 'Sano';
    case 'yellow': return 'Vigilar';
    case 'red':    return 'Crítico';
    default:       return 'Sin dato';
  }
}
