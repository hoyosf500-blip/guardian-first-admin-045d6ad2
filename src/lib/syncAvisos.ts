/**
 * ¿Este renglón de `sync_logs` es un PROBLEMA, o un aviso que se resuelve solo?
 *
 * El panel de Admin pintaba de ROJO —bajo el título "Sincronización fallida"—
 * todo lo que tuviera status `error` **o** `warn`. Pero hay warns que no son
 * fallas: cuando hay varias tiendas, el cron reparte su presupuesto y posterga
 * alguna para la corrida siguiente. Eso se registra a propósito (sin fila, el
 * indicador de frescura creería que el cron está caído), pero **es el sistema
 * funcionando como debe**.
 *
 * Resultado: el 19-ago-2026 un dueño nuevo abrió su panel y vio "5 errores en
 * las últimas 24 horas" con la sincronización perfectamente sana — el aviso
 * verde de arriba decía "sincronizado hace 3 min". Lo primero que hizo fue
 * escribir preguntando qué estaba roto. Nada estaba roto.
 *
 * Criterio para agregar algo acá: el sistema tiene que **resolverlo solo, sin
 * que nadie haga nada**. Ante la duda, NO es benigno — que una falla real pase
 * por normal es mucho peor que un susto de más.
 *
 * El throttle de Dropi NO entra: dice "reintenta solo", pero cuando se vuelve
 * crónico es un problema real que hay que ver.
 */

export interface SyncLogRow {
  status?: string | null;
  error_message?: string | null;
}

/** Avisos que el sistema se resuelve solo en la próxima corrida. */
const BENIGNOS: RegExp[] = [
  /postergada en esta corrida/i,
];

export function esAvisoQueSeResuelveSolo(row: SyncLogRow): boolean {
  // Un `error` NUNCA es benigno, diga lo que diga el mensaje.
  if (String(row?.status ?? '').toLowerCase() === 'error') return false;
  const msg = String(row?.error_message ?? '');
  if (!msg) return false;
  return BENIGNOS.some((re) => re.test(msg));
}

/** Parte las filas en las que exigen atención y las que no. */
export function partirAvisos<T extends SyncLogRow>(rows: T[]): { problemas: T[]; normales: T[] } {
  const problemas: T[] = [];
  const normales: T[] = [];
  for (const r of rows) (esAvisoQueSeResuelveSolo(r) ? normales : problemas).push(r);
  return { problemas, normales };
}
