// pollWhenVisible — helper para crear intervals que NO consumen recursos
// cuando la pestaña está oculta. Reduce ~50% del consumo de DB cuando las
// operadoras dejan tabs abiertas en background.
//
// Uso:
//   useEffect(() => {
//     return pollWhenVisible(myFn, 15 * 60 * 1000);
//   }, [myFn]);
//
// ⛔ Y con FRENO (5-sep-2026): si el cortacircuitos de la base está abierto
// (`frenoBase`), el tick se salta. Trece polls distintos viven sobre este
// helper; cuando la base se congeló 20 minutos, los trece siguieron pegándole
// puntualmente desde cada pestaña. Un poll que insiste contra una base que no
// contesta no trae el dato: solo alarga la cola. El tick que se saltó se
// recupera solo cuando el freno se cierra (ver `onCambio` abajo).

import { abierto, onCambio } from './frenoBase';

export function pollWhenVisible(
  fn: () => void,
  intervalMs: number,
  opts: { runOnVisible?: boolean } = {},
): () => void {
  const { runOnVisible = true } = opts;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let seSaltoUno = false;

  const tick = () => {
    if (abierto()) { seSaltoUno = true; return; }
    fn();
  };
  const start = () => {
    if (intervalId !== null) return;
    intervalId = setInterval(tick, intervalMs);
  };
  // Al cerrarse el freno, UNA recuperación del tick que se perdió — solo si la
  // pestaña está a la vista, igual que el resto del helper.
  const bajaFreno = onCambio((e) => {
    if (!e.abierto && seSaltoUno && document.visibilityState === 'visible') {
      seSaltoUno = false;
      fn();
    }
  });
  const stop = () => {
    if (intervalId === null) return;
    clearInterval(intervalId);
    intervalId = null;
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      if (runOnVisible) tick();
      start();
    } else {
      stop();
    }
  };

  // Arranca solo si la pestaña está activa
  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stop();
    bajaFreno();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
