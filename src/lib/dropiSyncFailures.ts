// Helpers PUROS para el panel de fallos de sync con Dropi
// (DropiSyncFailuresPanel). Sin imports de react/supabase — testeable directo.

// Resultados de edición (OrderEditorDialog, patrón pending→synced/failed).
export const EDIT_RESULTS = ['cambio_transportadora', 'cambio_valor', 'edicion_completa', 'edicion_orden'] as const;
export const EDIT_LABEL: Record<string, string> = {
  cambio_transportadora: 'Transportadora',
  cambio_valor: 'Valor',
  edicion_completa: 'Edición de orden',
  edicion_orden: 'Datos del cliente',
};

/** Alerta de DUPLICADO VIVO (no una edición de datos que falló):
 *  dropi-change-carrier inserta filas result='edicion_orden' failed cuyas
 *  result_notes contienen 'DUPLICADO VIVO en Dropi: #<id>' cuando CONFIRMÓ
 *  una hermana viva (guard + sweep — verificado: todas esas notas llevan el
 *  literal). SOLO ese literal: el prefijo 'EDICIÓN: ' del guard también lo
 *  llevan warnings de verificación INCIERTA ('No pude verificar si la orden
 *  vieja...') que NO son duplicados confirmados — matchearlos mostraría un
 *  CTA "Cancelá el duplicado" sobre una orden probablemente muerta. */
export function isDuplicadoVivo(notes: string): boolean {
  return notes.includes('DUPLICADO VIVO');
}

/** Evidencia de que una edición SÍ aplicó en Dropi aunque la auditoría haya
 *  quedado pending/failed (settle del cliente bloqueado por RLS pre-fix):
 *  orders.last_edit_sync_at solo se estampa cuando la edición APLICÓ en Dropi,
 *  así que un last_edit_sync_at >= created_at de la fila la desmiente. */
export function editAppliedEvidence(
  result: string,
  createdAt: string,
  lastEditSyncAt: string | null | undefined,
): boolean {
  if (!(EDIT_RESULTS as readonly string[]).includes(result)) return false;
  if (!lastEditSyncAt) return false;
  const applied = Date.parse(lastEditSyncAt);
  const created = Date.parse(createdAt);
  if (!Number.isFinite(applied) || !Number.isFinite(created)) return false;
  return applied >= created;
}

/** Primer #<id> tipo Dropi en la nota (5+ dígitos — evita falsos positivos
 *  con números cortos tipo '#2 intentos'). */
export function parseFirstOrderRef(notes: string): string | null {
  const m = notes.match(/#(\d{5,})/);
  return m ? m[1] : null;
}
