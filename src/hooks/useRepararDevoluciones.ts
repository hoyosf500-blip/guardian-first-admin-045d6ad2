import { useCallback, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Repesca desde Dropi los pedidos cuya devolución la billetera ya cobró pero el
 * CRM no refleja (los `no_esta` y `no_marcado` de la conciliación).
 *
 * La cura es la misma para los dos casos: preguntarle a Dropi por ese pedido.
 * `dropi-refresh-order` hace `GET /integrations/orders/{external_id}` y upsertea
 * por external_id, así que sirve tanto para INSERTAR el que nunca llegó como
 * para ACTUALIZAR el que quedó con estado viejo.
 *
 * TRES cosas que este hook NO puede hacer de otra manera:
 *
 * 1. **Ir de a uno y con pausa.** Son decenas de pedidos y Dropi throttlea
 *    (429) bajo ráfaga — Ecuador ya dejó el cron sincronizando en cero por esto.
 *    Disparar 61 requests en paralelo es la forma garantizada de que Dropi corte
 *    y la reparación falle entera.
 * 2. **Frenar al primer 429 sostenido.** Insistir contra un servidor que ya dijo
 *    "basta" empeora el throttle para TODO el CRM, no solo para esta pantalla.
 *    Un reintento con espera; si vuelve, se corta y se informa lo hecho.
 * 3. **Trabajar por tandas.** Con un tope por corrida el dueño ve avance real y
 *    puede parar. Una barra que no se mueve durante cuatro minutos se lee como
 *    "se colgó" y termina en un F5 que aborta todo a la mitad.
 */

/** Tope por corrida: ~40 × 700 ms ≈ 30 s, que es lo que alguien mira sin irse. */
export const MAX_POR_TANDA = 40;
/** Pausa entre pedidos. Sin esto Dropi devuelve 429 y no se repara nada. */
const PAUSA_MS = 700;
/** Espera tras el primer 429 antes del único reintento. */
const BACKOFF_MS = 4000;

export interface ProgresoReparacion {
  corriendo: boolean;
  /** Procesados en esta tanda. */
  hechos: number;
  /** Total de esta tanda (≤ MAX_POR_TANDA). */
  total: number;
  reparados: number;
  fallidos: number;
  /** Quedaron fuera de la tanda: se reparan dándole de nuevo al botón. */
  restantes: number;
  /** Se cortó por throttle de Dropi (no por error nuestro). */
  frenadoPorThrottle: boolean;
}

const INICIAL: ProgresoReparacion = {
  corriendo: false, hechos: 0, total: 0, reparados: 0,
  fallidos: 0, restantes: 0, frenadoPorThrottle: false,
};

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useRepararDevoluciones() {
  const [progreso, setProgreso] = useState<ProgresoReparacion>(INICIAL);
  const abortarRef = useRef(false);

  const cancelar = useCallback(() => { abortarRef.current = true; }, []);

  const reparar = useCallback(async (
    storeId: string | null | undefined,
    externalIds: string[],
  ): Promise<ProgresoReparacion> => {
    const tanda = (externalIds || []).slice(0, MAX_POR_TANDA);
    const restantesIniciales = Math.max(0, (externalIds || []).length - tanda.length);
    if (!storeId || tanda.length === 0) {
      const nada = { ...INICIAL, restantes: restantesIniciales };
      setProgreso(nada);
      return nada;
    }

    abortarRef.current = false;
    let reparados = 0;
    let fallidos = 0;
    let frenadoPorThrottle = false;
    let hechos = 0;

    setProgreso({
      corriendo: true, hechos: 0, total: tanda.length, reparados: 0,
      fallidos: 0, restantes: restantesIniciales, frenadoPorThrottle: false,
    });

    const pedirUno = async (ext: string) => {
      const { data, error } = await supabase.functions.invoke('dropi-refresh-order', {
        body: { store_id: storeId, external_id: ext },
      });
      if (error) return { ok: false, rateLimited: false };
      const r = (data || {}) as { ok?: boolean; rateLimited?: boolean };
      return { ok: Boolean(r.ok), rateLimited: Boolean(r.rateLimited) };
    };

    for (const ext of tanda) {
      if (abortarRef.current) break;
      let r = await pedirUno(ext);
      if (r.rateLimited) {
        // Un solo reintento con espera. Si Dropi insiste, se corta: seguir
        // golpeando degrada el sync de toda la operación.
        await dormir(BACKOFF_MS);
        if (abortarRef.current) break;
        r = await pedirUno(ext);
        if (r.rateLimited) { frenadoPorThrottle = true; break; }
      }
      if (r.ok) reparados++; else fallidos++;
      hechos++;
      setProgreso((p) => ({ ...p, hechos, reparados, fallidos }));
      await dormir(PAUSA_MS);
    }

    // Lo que no se alcanzó a tocar vuelve a la cuenta de pendientes: el número
    // que ve el dueño tiene que seguir siendo verdad después de un corte.
    const noTocados = tanda.length - hechos;
    const final: ProgresoReparacion = {
      corriendo: false,
      hechos,
      total: tanda.length,
      reparados,
      fallidos,
      restantes: restantesIniciales + noTocados,
      frenadoPorThrottle,
    };
    setProgreso(final);
    return final;
  }, []);

  return { progreso, reparar, cancelar };
}
