// Helpers PUROS de teléfono para matchear por SUFIJO (últimos N dígitos), agnóstico
// al formato (+57, 0 inicial, espacios, guiones). Sin Deno globals → testeable en
// Vitest. Lo usa wa-status-notifier (modo solo-warm) y sirve a cualquier match de
// teléfonos entre Dropi (orders.phone) y WhatsApp (wa_conversations.customer_phone).

/** Últimos N dígitos del teléfono (default 10). "" si no hay dígitos. */
export function phoneSuffix(phone: unknown, n = 10): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length <= n ? d : d.slice(-n);
}

/** ¿Dos teléfonos son el mismo, comparando por sufijo de N dígitos? Exige un sufijo
 *  de al menos 7 dígitos para no dar falsos positivos con números cortos/vacíos. */
export function samePhone(a: unknown, b: unknown, n = 10): boolean {
  const sa = phoneSuffix(a, n);
  const sb = phoneSuffix(b, n);
  return sa.length >= 7 && sa === sb;
}
