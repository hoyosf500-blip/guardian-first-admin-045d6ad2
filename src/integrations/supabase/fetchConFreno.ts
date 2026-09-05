import { registrarRespuesta } from '@/lib/frenoBase';

/**
 * El `fetch` que usa el cliente de Supabase: idéntico al del navegador, pero
 * le cuenta a `frenoBase` cuánto tardó cada respuesta y con qué status.
 *
 * ⛔ SOLO OBSERVA. No agrega timeouts, no reintenta, no bloquea, no cambia el
 * cuerpo ni los headers. Una edge function como `dropi-refresh-batch` tarda
 * 30 s legítimos y tiene que poder tardarlos. Cortar acá sería romper cosas
 * que hoy funcionan para arreglar otra.
 *
 * Por qué acá y no en 140 llamadores: es el único punto por el que pasa TODA
 * petición a Supabase (REST, RPC, auth, edge functions). Ver `frenoBase.ts`
 * para la historia del 5-sep-2026.
 */
export const fetchConFreno: typeof fetch = async (entrada, init) => {
  const t0 = performance.now();
  try {
    const r = await fetch(entrada, init);
    registrarRespuesta({ ms: performance.now() - t0, status: r.status });
    return r;
  } catch (e) {
    // Una petición abortada a propósito por la app (AbortController) no es un
    // síntoma de la base. Solo cuenta lo que falló solo.
    const abortada = e instanceof DOMException && e.name === 'AbortError';
    if (!abortada) registrarRespuesta({ ms: performance.now() - t0, fallo: true });
    throw e;
  }
};
