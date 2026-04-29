// pollWhenVisible — helper para crear intervals que NO consumen recursos
// cuando la pestaña está oculta. Reduce ~50% del consumo de DB cuando las
// operadoras dejan tabs abiertas en background.
//
// Uso:
//   useEffect(() => {
//     return pollWhenVisible(myFn, 15 * 60 * 1000);
//   }, [myFn]);

export function pollWhenVisible(
  fn: () => void,
  intervalMs: number,
  opts: { runOnVisible?: boolean } = {},
): () => void {
  const { runOnVisible = true } = opts;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (intervalId !== null) return;
    intervalId = setInterval(fn, intervalMs);
  };
  const stop = () => {
    if (intervalId === null) return;
    clearInterval(intervalId);
    intervalId = null;
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      if (runOnVisible) fn();
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
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
