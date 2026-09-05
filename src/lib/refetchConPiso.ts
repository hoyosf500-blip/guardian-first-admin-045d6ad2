import { abierto } from './frenoBase';

/**
 * Un refetch disparado por realtime, con PISO y con freno.
 *
 * ── El problema que resuelve (5-sep-2026) ───────────────────────────────────
 * Cada gestión de una asesora (un INSERT en `order_results` o `touchpoints`, un
 * UPDATE de `orders` al abrir o cerrar una tarjeta) llegaba por realtime a
 * TODAS las pestañas abiertas, y cada una recargaba lo suyo con un debounce de
 * 400 ms a 1,5 s: el panel de productividad sus 4 RPCs de agregación, el equipo
 * en vivo sus 6 consultas, la bandeja sus 2 RPCs, la barra del turno la suya.
 * Cuatro asesoras marcando cada 20 s son ~12 gestiones por minuto; por cinco
 * pestañas y ~10 consultas cada una, son **600 consultas por minuto** que nadie
 * pidió, sobre una base chica. Ese fue el combustible de la caída de 20 min.
 *
 * Un debounce no sirve: con gestiones entrando sin parar se reinicia y dispara
 * en huecos aleatorios, o nunca. Esto es un **throttle trailing con piso**: la
 * primera llamada sale enseguida (o cuando venza el piso desde la anterior), y
 * todo lo que llegue mientras tanto se junta en UNA sola salida.
 *
 * Y si el cortacircuitos de la base está abierto, no sale: se vuelve a agendar
 * para dentro de un piso más, y así hasta que la base respire. La actualización
 * no se pierde — se posterga.
 */
export interface RefetchConPiso {
  /** Pedí una recarga. Se agrupa con las demás que lleguen en el piso. */
  pedir: () => void;
  /** Cancela lo pendiente (para el cleanup del efecto). */
  cancelar: () => void;
}

export function crearRefetchConPiso(fn: () => void, pisoMs: number): RefetchConPiso {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ultimo = 0;

  const disparar = () => {
    timer = null;
    if (abierto()) {
      // La base está ahogada: esta recarga espera un piso más. No se descarta.
      timer = setTimeout(disparar, pisoMs);
      return;
    }
    ultimo = Date.now();
    fn();
  };

  return {
    pedir() {
      if (timer) return; // ya hay una salida programada: se suma a ésa
      const espera = Math.max(0, pisoMs - (Date.now() - ultimo));
      timer = setTimeout(disparar, espera);
    },
    cancelar() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
