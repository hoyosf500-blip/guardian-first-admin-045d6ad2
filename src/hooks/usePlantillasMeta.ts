import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import type { PlantillaMeta } from '@/lib/plantillasMeta';
import { motivoEdge, cuerpoDelError } from '@/lib/errorEdge';
import type { ModuloEnvio } from '@/hooks/useEnviarWhatsapp';

/**
 * Las plantillas aprobadas por Meta, para cuando la ventana de 24 h ya venció.
 *
 * No decide nada: el servidor (`importchat-plantillas`) valida la credencial,
 * revalida que los huecos estén completos y arma el payload. Acá solo se
 * traduce el resultado a algo que la asesora pueda leer.
 *
 * Nunca lanza. Y `ok:true` en el envío significa **ImporChat lo confirmó**, no
 * "se emitió" — misma disciplina que `useEnviarWhatsapp`.
 */
export type EstadoPlantillas = 'inicial' | 'cargando' | 'ok' | 'sin_config' | 'error';

/** Lovable no redespliega edge functions con un push: la función puede no
 *  existir todavía en el servidor y el gateway contesta NOT_FOUND. */
export const PLANTILLAS_SIN_DESPLEGAR =
  'El envío de plantillas todavía no está activado en el servidor. Mandala desde ImporChat y avisá para que lo activen.';

async function motivoReal(error: unknown, porDefecto: string) {
  return motivoEdge(error, await cuerpoDelError(error), PLANTILLAS_SIN_DESPLEGAR, porDefecto);
}

/**
 * Trae las plantillas cuando `activo` se pone en true, ordenadas para la fase
 * del pedido. Se pide UNA vez por apertura: la lista de Meta no cambia entre
 * dos clics, y son 31 plantillas por llamada.
 */
export function usePlantillasMeta(activo: boolean, fase?: string | null) {
  const { activeStoreId } = useStore();
  const [plantillas, setPlantillas] = useState<PlantillaMeta[]>([]);
  const [estado, setEstado] = useState<EstadoPlantillas>('inicial');
  const [error, setError] = useState<string | undefined>();
  // Contra respuestas que llegan tarde: si mientras carga se abre otro pedido,
  // la respuesta vieja NO puede pintar la lista del nuevo.
  const turnoRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!activeStoreId) return;
    const turno = ++turnoRef.current;
    setEstado('cargando');
    setError(undefined);
    try {
      const { data, error: err } = await supabase.functions.invoke('importchat-plantillas', {
        body: { store_id: activeStoreId, accion: 'listar', fase: fase ?? null },
      });
      if (turno !== turnoRef.current) return;
      if (err) {
        const { detalle, sinConfig } = await motivoReal(err, 'No se pudieron leer las plantillas');
        if (turno !== turnoRef.current) return;
        setEstado(sinConfig ? 'sin_config' : 'error');
        setError(sinConfig ? undefined : detalle);
        setPlantillas([]);
        return;
      }
      const r = data as { ok?: boolean; plantillas?: PlantillaMeta[]; error?: string } | null;
      if (!r?.ok) {
        setEstado('error');
        setError(r?.error || 'No se pudieron leer las plantillas');
        setPlantillas([]);
        return;
      }
      setPlantillas(r.plantillas ?? []);
      setEstado('ok');
    } catch (e) {
      if (turno !== turnoRef.current) return;
      setEstado('error');
      setError(e instanceof Error ? e.message : 'No se pudieron leer las plantillas');
    }
  }, [activeStoreId, fase]);

  useEffect(() => {
    if (activo && estado === 'inicial') void cargar();
  }, [activo, estado, cargar]);

  return { plantillas, estado, error, recargar: cargar };
}

export interface ResultadoPlantilla {
  ok: boolean;
  error?: string;
  /** Qué huecos quedaron vacíos, si el servidor frenó por eso. */
  faltantes?: number[];
}

export function useEnviarPlantilla() {
  const { activeStoreId } = useStore();
  const [enviando, setEnviando] = useState(false);

  const enviarPlantilla = useCallback(async (
    externalId: string,
    nombre: string,
    valores: Record<number, string>,
    modulo?: ModuloEnvio,
  ): Promise<ResultadoPlantilla> => {
    if (!activeStoreId) return { ok: false, error: 'No hay tienda activa' };
    setEnviando(true);
    try {
      const { data, error } = await supabase.functions.invoke('importchat-plantillas', {
        body: { store_id: activeStoreId, accion: 'enviar', external_id: externalId, nombre, valores, modulo },
      });
      if (error) {
        const { detalle } = await motivoReal(error, 'No se pudo enviar la plantilla');
        return { ok: false, error: detalle };
      }
      const r = data as { ok?: boolean; error?: string; faltantes?: number[] } | null;
      if (!r?.ok) return { ok: false, error: r?.error || 'No se pudo confirmar el envío', faltantes: r?.faltantes };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'No se pudo enviar la plantilla' };
    } finally {
      setEnviando(false);
    }
  }, [activeStoreId]);

  return { enviarPlantilla, enviando };
}
