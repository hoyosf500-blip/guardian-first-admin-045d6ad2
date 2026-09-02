import { useEffect, useState } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { canalDeTienda, type CanalChat } from '@/lib/canalChat';

/**
 * Por dónde atiende la tienda activa: `importchat` (EC) o `chateapro` (CO).
 * `null` mientras se resuelve.
 *
 * Existe para que ninguna pantalla nombre un canal que esa tienda no usa.
 * ⛔ Visto en producción el 2-sep-2026 con Rushmira (Colombia) abierta: el
 * encabezado decía «ImporChat sin correr» y el cuadro de escribir decía «no
 * tiene conversación en ImporChat». ImporChat es el canal de ECUADOR — a la
 * asesora colombiana se la estaba mandando a la app de otro país, donde esa
 * conversación no existe.
 */
export function useCanalChat(): CanalChat | null {
  const { activeStoreId } = useStore();
  const [canal, setCanal] = useState<CanalChat | null>(null);

  useEffect(() => {
    if (!activeStoreId) { setCanal(null); return; }
    let vivo = true;
    void canalDeTienda(activeStoreId).then(c => { if (vivo) setCanal(c); });
    return () => { vivo = false; };
  }, [activeStoreId]);

  return canal;
}

/** El nombre para mostrarle a la asesora. */
export function nombreCanal(canal: CanalChat | null): string {
  return canal === 'chateapro' ? 'Chatea Pro' : 'ImporChat';
}
