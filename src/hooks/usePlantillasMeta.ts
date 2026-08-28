import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import type { PlantillaMeta } from '@/lib/plantillasMeta';
import { motivoEdge, cuerpoDelError } from '@/lib/errorEdge';
import { emitirGestion } from '@/lib/eventosGestion';
import type { ModuloEnvio, GestionDelEnvio } from '@/hooks/useEnviarWhatsapp';

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
 * Caché por (tienda, fase), compartido entre TODAS las instancias del hook.
 *
 * ⛔ Sin esto, el botón de acción de cada tarjeta pide la lista por su cuenta:
 * un tablero con 83 pedidos en agencia son 83 llamadas a ImporChat para traer
 * exactamente las mismas 40 plantillas. Lento, caro, y el camino más corto a un
 * throttle de la API. Con el caché son una por fase.
 *
 * TTL corto porque una plantilla recién aprobada en Meta tiene que poder
 * aparecer sin recargar la pestaña. `recargar()` lo saltea siempre: cuando la
 * asesora toca "probar de nuevo" quiere el dato fresco, no el que falló.
 */
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; plantillas: PlantillaMeta[] }>();

/**
 * Trae las plantillas cuando `activo` se pone en true, ordenadas para la fase
 * del pedido. Se pide UNA vez por (tienda, fase): la lista de Meta no cambia
 * entre dos clics, y son ~40 plantillas por llamada.
 */
export function usePlantillasMeta(activo: boolean, fase?: string | null) {
  const { activeStoreId } = useStore();
  const [plantillas, setPlantillas] = useState<PlantillaMeta[]>([]);
  const [estado, setEstado] = useState<EstadoPlantillas>('inicial');
  const [error, setError] = useState<string | undefined>();
  // Contra respuestas que llegan tarde: si mientras carga se abre otro pedido,
  // la respuesta vieja NO puede pintar la lista del nuevo.
  const turnoRef = useRef(0);

  const cargar = useCallback(async (forzar = false) => {
    if (!activeStoreId) return;
    const clave = `${activeStoreId}|${fase ?? ''}`;
    const guardado = cache.get(clave);
    if (!forzar && guardado && Date.now() - guardado.at < CACHE_MS) {
      turnoRef.current += 1;
      setPlantillas(guardado.plantillas);
      setEstado('ok');
      setError(undefined);
      return;
    }
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
      const lista = r.plantillas ?? [];
      // Solo se cachea el ÉXITO. Guardar una lista vacía por un error dejaría
      // "esta cuenta no tiene plantillas" pegado 5 minutos, que es una
      // afirmación falsa sobre la cuenta del cliente.
      cache.set(clave, { at: Date.now(), plantillas: lista });
      setPlantillas(lista);
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

  return { plantillas, estado, error, recargar: () => cargar(true) };
}

export interface ResultadoPlantilla {
  ok: boolean;
  error?: string;
  /** Qué huecos quedaron vacíos, si el servidor frenó por eso. */
  faltantes?: number[];
}

export function useEnviarPlantilla() {
  const { activeStoreId } = useStore();
  const { user } = useAuth();
  const [enviando, setEnviando] = useState(false);

  const enviarPlantilla = useCallback(async (
    externalId: string,
    nombre: string,
    valores: Record<number, string>,
    modulo?: ModuloEnvio,
    gestion?: GestionDelEnvio,
  ): Promise<ResultadoPlantilla> => {
    if (!activeStoreId) return { ok: false, error: 'No hay tienda activa' };
    setEnviando(true);
    try {
      const { data, error } = await supabase.functions.invoke('importchat-plantillas', {
        // `gestion` es ADITIVO: un servidor sin redesplegar lo ignora y escribe
        // "Mandé la plantilla X" como siempre. Ver `useEnviarWhatsapp`.
        body: { store_id: activeStoreId, accion: 'enviar', external_id: externalId, nombre, valores, modulo, gestion: gestion?.accion },
      });
      if (error) {
        const { detalle } = await motivoReal(error, 'No se pudo enviar la plantilla');
        return { ok: false, error: detalle };
      }
      const r = data as { ok?: boolean; error?: string; faltantes?: number[]; ya_enviado?: boolean } | null;
      if (!r?.ok) return { ok: false, error: r?.error || 'No se pudo confirmar el envío', faltantes: r?.faltantes };
      // El touchpoint lo escribe el servidor: sin este aviso el contador de la
      // pantalla no se entera hasta recargar (mismo bug que se acaba de
      // arreglar en `useRecordGestion`).
      //
      // ⛔ `ya_enviado` = la idempotencia diaria frenó el reenvío y el servidor
      // NO insertó un segundo touchpoint. Emitirlo igual sumaría un intento que
      // no existe en la base, y la tarjeta diría "gestionado" por un mensaje
      // que ya se había mandado antes.
      if (gestion?.phone && !r.ya_enviado) {
        emitirGestion({
          phone: gestion.phone,
          modulo: modulo === 'WHATSAPP' ? 'WHATSAPP' : 'SEG',
          accion: gestion.accion || `Mandé la plantilla ${nombre}`,
          operatorId: user?.id ?? null,
          at: new Date().toISOString(),
        });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'No se pudo enviar la plantilla' };
    } finally {
      setEnviando(false);
    }
  }, [activeStoreId, user]);

  return { enviarPlantilla, enviando };
}
