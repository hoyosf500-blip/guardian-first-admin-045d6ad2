// horaLocal — fecha y hora LOCAL de la tienda para los touchpoints.
//
// Las tres funciones de WhatsApp hardcodeaban `-5h` para la fecha y dejaban la
// HORA en UTC (`ahora.toISOString().slice(11,16)`) — o sea la hora salía corrida
// 5 h para TODOS los países, y la fecha 1 h para Guatemala (UTC-6, no -5) cerca
// de medianoche (finding #9). Los inserts del cliente (OrderContext/useRecordGestion)
// usan hora LOCAL, así que los de las edge functions quedaban inconsistentes.
//
// Sin imports: puede vivir en Deno sin romper nada.

/** Offset horario por país (mismo que usa importchat-sync). Default -5. */
export const OFFSET_HORAS: Record<string, number> = { CO: -5, EC: -5, GT: -6 };

/**
 * Fecha 'YYYY-MM-DD' y hora 'HH:MM' en el reloj LOCAL de la tienda.
 * Se toma UTC y se le suma el offset (negativo): así los campos UTC del Date
 * resultante coinciden con la hora de pared local.
 */
export function fechaHoraLocal(
  country: string | null | undefined,
  ahora: Date = new Date(),
): { fecha: string; hora: string } {
  const off = OFFSET_HORAS[String(country || "").toUpperCase()] ?? -5;
  const local = new Date(ahora.getTime() + off * 3600_000);
  const iso = local.toISOString();
  return { fecha: iso.slice(0, 10), hora: iso.slice(11, 16) };
}
