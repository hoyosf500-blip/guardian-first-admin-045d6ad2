/**
 * Decisión de APERTURA DE TURNO — pura, sin red ni React.
 *
 * Vive separada de `WelcomeGate` por una razón concreta: la regla que decide
 * esto no se puede probar con la sesión del dueño. El dueño es admin, y a los
 * admin no se les ficha jornada, así que el camino de la operadora —
 * justamente el que importa — nunca se ejecuta en su navegador. Acá se puede
 * verificar con tests en vez de esperar a que entre alguien mañana.
 *
 * El pedido que blinda (dueño, 2026-07-19): "ya hice apertura, pero si cierro
 * el CRM y vuelvo a entrar sin hacer cierre, no me tiene que volver a contar
 * la apertura".
 */

/**
 * Cuánto puede tener la marca de entrada para que esto cuente como APERTURA.
 *
 * La marca la sella el servidor en el primer latido del día. Si al abrir la
 * pantalla esa marca es de hace segundos, la acaba de crear esta misma sesión
 * → apertura de verdad. Si es de hace horas, la operadora YA había abierto hoy
 * y esto es una re-entrada.
 *
 * 90s es holgado a propósito: el latido y la consulta salen los dos al montar,
 * con milisegundos de diferencia. El margen cubre una conexión lenta, no
 * tolera re-entradas — cualquier vuelta real ocurre minutos u horas después.
 */
export const VENTANA_APERTURA_MS = 90 * 1000;

export interface DecisionApertura {
  /** Mostrar la animación de bienvenida. */
  saludar: boolean;
  /**
   * Timestamp ISO a mostrar en el chip "Turno iniciado", o `null` para NO
   * mostrar el chip. Nunca se deriva del reloj local: o sale del servidor o
   * no se muestra.
   */
  horaSellada: string | null;
}

export function decidirApertura(opts: {
  esAdmin: boolean;
  /** `first_action_at` de hoy leído del servidor, o null si no hay/falló. */
  marcaEntrada: string | null;
  ahora?: number;
}): DecisionApertura {
  const { esAdmin, marcaEntrada, ahora = Date.now() } = opts;

  // Al dueño se lo saluda, pero no ficha jornada: anunciarle un turno sería
  // mentirle. Ni siquiera se consulta la marca.
  if (esAdmin) return { saludar: true, horaSellada: null };

  // Sin marca: el latido falló o viene en camino. Se saluda igual —la
  // bienvenida no depende de la base— pero SIN hora. Preferimos callar a
  // inventar una hora que nadie selló.
  if (!marcaEntrada) return { saludar: true, horaSellada: null };

  const t = new Date(marcaEntrada).getTime();
  // Marca corrupta: mismo criterio que "sin marca". No adivinamos.
  if (Number.isNaN(t)) return { saludar: true, horaSellada: null };

  // ⬇ EL CASO QUE PIDIÓ BLINDAR EL DUEÑO. Ya había abierto hoy (cerró el CRM,
  // se le cayó el navegador, entró desde otra máquina, le borraron la caché).
  // El servidor conserva la hora ORIGINAL. Esto no es una apertura: ni se
  // saluda de nuevo ni se anuncia un turno que ya estaba abierto.
  if (ahora - t >= VENTANA_APERTURA_MS) return { saludar: false, horaSellada: null };

  // Apertura genuina: la marca es de recién y es la que selló el servidor.
  return { saludar: true, horaSellada: marcaEntrada };
}
