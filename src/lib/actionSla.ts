export const ACTION_SLA_HOURS: Record<string, number> = {
  'Llame cliente': 6,
  'WhatsApp enviado': 4,
  'Esperando respuesta': 24,
  'Reclame transportadora': 48,
  'Cliente recogera': 72,
  'Resuelto': 720,            // 30 días — sale de la vista hasta nuevo ciclo
  'Devolucion solicitada': 720,
};

export function getActionSLA(actionRaw: string): number {
  const clean = actionRaw.replace(/^(SEG|RESCUE):\s*/, '').trim();
  return ACTION_SLA_HOURS[clean] ?? 24; // default 24h si no encuentra
}
