/**
 * El protocolo de la agencia, del lado del DATO.
 *
 * La asesora marca «Avisé: en oficina» y eso se guarda como touchpoint desde
 * hace meses — pero **no lo leía nadie**: solo dibujaba un ícono en la botonera.
 * En la práctica el tablero no distinguía al cliente al que ya se le avisó del
 * que no sabe que su paquete llegó, y ésa es exactamente la diferencia entre
 * una entrega y una devolución. Es la pérdida más cara medida: 76 devoluciones
 * en un mes en Ecuador ($2.316).
 *
 * Acá vive la lógica pura. La lee `useSegClosedPhones` (que ya pagina esos
 * mismos touchpoints, así que no cuesta una consulta más) y la muestran el
 * tablero y la barra «Lo que sigue».
 */

/** El método exacto que ofrece la botonera (src/lib/segMetodosEstado.ts). */
export const AVISO_AGENCIA_ACTION = 'Avisé: en oficina';

const norm = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * ¿Este touchpoint es el aviso de que el paquete espera en la agencia?
 *
 * Tolerante al prefijo de módulo (`SEG: `) y a los acentos, porque el histórico
 * se escribió con y sin ellos y un aviso que no se reconoce se lee como «nunca
 * se avisó» — o sea, manda a la asesora a repetir un trabajo ya hecho.
 */
export function esAvisoAgencia(action: string | null | undefined): boolean {
  if (!action) return false;
  return norm(action).includes('avise: en oficina') || norm(action).includes('avise en oficina');
}

/**
 * Estado del aviso para UN pedido que está esperando en la agencia.
 *
 *  - `sin_avisar` → el cliente no sabe (o no sabemos que sepa) que su paquete
 *    llegó. Es el trabajo pendiente.
 *  - `avisado`    → ya se le avisó DURANTE esta estadía en la agencia.
 *  - `sin_dato`   → no se puede afirmar ninguna de las dos. **No es cero.**
 */
export type EstadoAviso = 'sin_avisar' | 'avisado' | 'sin_dato';

export interface EntradaAviso {
  /** Último aviso registrado para ESE teléfono, en ms. */
  avisoMs?: number | null;
  /** `last_movement_at`: cuándo llegó el paquete a la agencia, en ms. */
  llegadaMs?: number | null;
}

/**
 * El aviso solo cuenta si es POSTERIOR a la llegada del paquete a la agencia.
 *
 * Los touchpoints matchean por TELÉFONO, no por `order_id` (la tabla no lo
 * guarda). Sin esta regla, un cliente que ya compró antes arrastraría el aviso
 * de su pedido anterior y el paquete de hoy se vería «avisado» sin que nadie lo
 * haya llamado — el error caro, porque lo saca de la cola en silencio.
 *
 * Y sin `llegadaMs` no se afirma nada: no se puede validar contra qué estadía
 * es el aviso. Mismo criterio que `agencia_2d`, que sin reloj no matchea.
 */
export function estadoAvisoAgencia({ avisoMs, llegadaMs }: EntradaAviso): EstadoAviso {
  if (!llegadaMs || !isFinite(llegadaMs)) return 'sin_dato';
  if (!avisoMs || !isFinite(avisoMs)) return 'sin_avisar';
  return avisoMs >= llegadaMs ? 'avisado' : 'sin_avisar';
}

/** Días enteros transcurridos desde el aviso; null si no hubo o no aplica. */
export function diasDesdeAviso(entrada: EntradaAviso, ahora: number): number | null {
  if (estadoAvisoAgencia(entrada) !== 'avisado') return null;
  const ms = ahora - (entrada.avisoMs as number);
  if (ms < 0) return null;
  return Math.floor(ms / 86400000);
}

export interface ResumenAvisos {
  sinAvisar: number;
  avisados: number;
  /** Ni una cosa ni la otra: sin reloj de llegada. Se muestra, no se esconde. */
  sinDato: number;
  total: number;
}

/**
 * Cuenta el estado del protocolo sobre una lista de pedidos en agencia.
 *
 * `sinDato` va aparte y a la vista: meterlo en `avisados` inventaría trabajo
 * hecho, y meterlo en `sinAvisar` inventaría trabajo pendiente. Ninguna de las
 * dos mentiras es gratis para quien tiene que decidir a quién llamar.
 */
export function resumenAvisos(entradas: EntradaAviso[]): ResumenAvisos {
  const r: ResumenAvisos = { sinAvisar: 0, avisados: 0, sinDato: 0, total: entradas.length };
  for (const e of entradas) {
    const s = estadoAvisoAgencia(e);
    if (s === 'avisado') r.avisados++;
    else if (s === 'sin_avisar') r.sinAvisar++;
    else r.sinDato++;
  }
  return r;
}
