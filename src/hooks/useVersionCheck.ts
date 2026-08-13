import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/**
 * Aviso de "hay una versión nueva de Guardian".
 *
 * Guardian es UNA sola app hospedada: cuando se publica un arreglo, TODAS las
 * tiendas lo reciben al recargar. El hueco (auditoría 2026-08-13) es la pestaña
 * que quedó ABIERTA: sigue corriendo el bundle viejo indefinidamente — una
 * operadora puede pasar días sin recargar y sin el fix que ya está publicado, y
 * si navega a una ruta nueva se topa con un chunk que ya no existe (eso lo
 * atrapa ErrorBoundary y recarga solo).
 *
 * Cómo detecta: `index.html` se sirve con `no-cache` (verificado en vivo), así
 * que basta con volver a pedirlo y comparar el hash del bundle principal contra
 * el que esta pestaña tiene cargado. Sin service worker, sin endpoint nuevo,
 * sin versión que mantener a mano.
 *
 * Cómo avisa: un toast PERSISTENTE con botón "Actualizar". Nunca recarga solo —
 * una operadora a mitad de una llamada, con datos escritos en un formulario, no
 * puede perder la pantalla de golpe. Ella decide cuándo.
 */

/** Ritmo del chequeo. 5 min: un arreglo urgente llega rápido y el costo es un
 *  GET del HTML (pocos KB) — despreciable al lado del polling que ya hace el CRM. */
const INTERVALO_MS = 5 * 60 * 1000;
const BUNDLE_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** Hash del bundle que ESTA pestaña está corriendo. En dev (vite sirve
 *  /src/main.tsx, sin /assets/) devuelve null → el hook queda inerte. */
function bundleActual(): string | null {
  const scripts = Array.from(document.querySelectorAll('script[src]'));
  for (const s of scripts) {
    const src = s.getAttribute('src') ?? '';
    const m = src.match(BUNDLE_RE);
    if (m) return m[0];
  }
  return null;
}

export function useVersionCheck(): void {
  const avisadoRef = useRef(false);

  useEffect(() => {
    const actual = bundleActual();
    if (!actual) return; // dev / build sin hash: nada que vigilar

    let cancelado = false;

    async function chequear() {
      if (cancelado || avisadoRef.current) return;
      // Solo con la pestaña visible: una pestaña de fondo no necesita el aviso
      // (y al volver, el chequeo de visibilitychange lo hace enseguida).
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/?v=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const html = await res.text();
        const m = html.match(BUNDLE_RE);
        // Sin match no se concluye nada: mejor callar que avisar en falso.
        if (!m || m[0] === actual) return;
        avisadoRef.current = true;
        toast.info('Guardian se actualizó', {
          description: 'Hay una versión nueva. Actualizá cuando termines lo que estás haciendo — no perdés nada.',
          duration: Infinity,
          action: { label: 'Actualizar', onClick: () => window.location.reload() },
        });
      } catch {
        // Sin internet o servidor caído: silencio. El CRM ya tiene sus propios
        // avisos de conectividad; este no es el lugar para gritar.
      }
    }

    const id = window.setInterval(chequear, INTERVALO_MS);
    const alVolver = () => { if (document.visibilityState === 'visible') void chequear(); };
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      cancelado = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, []);
}
