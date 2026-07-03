// Distingue "el RPC/tabla NO está desplegado" (degradación INTENCIONAL — el
// call-site cae a un fallback a propósito) de un error REAL y transitorio
// (throttle de Dropi, 500, timeout, permiso). Es la lección del nightly-reconcile
// y del cron zombie: tragar TODO error como "degradá al fallback" hace que un
// throttle pasajero envenene el número de forma permanente (React Query nunca
// marca isError → nunca reintenta → el valor falso se queda hasta staleTime +
// remount), y la UI pinta un dato equivocado sin ninguna señal.
//
// Patrón de uso en un queryFn (idéntico a useEstadoBreakdown, el modelo):
//   if (error) {
//     if (isRpcMissing(error)) return FALLBACK; // degradación intencional
//     throw error;                              // transitorio → isError → retry
//   }
//
// Al re-lanzar el error transitorio, React Query lo reintenta (3x por defecto) y
// suele recuperarse solo; si persiste, el componente puede mostrar un aviso en
// vez de un número inventado.

interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
}

/** true SOLO si el error indica que la función/tabla no existe (PGRST202 /
 *  "could not find the function" / "does not exist" / 404 de PostgREST). */
export function isRpcMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as RpcErrorLike;
  if (e.code === 'PGRST202' || e.code === 'PGRST205' || e.code === '42883') return true;
  const msg = String(e.message ?? '');
  return /find the function|does not exist|schema cache|could not find/i.test(msg);
}
