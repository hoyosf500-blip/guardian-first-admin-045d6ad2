import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { ordenarParaFase, type PlantillaMeta } from '@/lib/plantillasMeta';
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

// ⛔ Vuelo en curso COMPARTIDO. Al abrir el tablero se precarga y además la
// asesora puede tocar un botón antes de que llegue: sin esto salían dos
// llamadas a ImporChat para la misma lista.
const enVuelo = new Map<string, Promise<PlantillaMeta[]>>();

async function traer(storeId: string): Promise<PlantillaMeta[]> {
  const guardado = cache.get(storeId);
  if (guardado && Date.now() - guardado.at < CACHE_MS) return guardado.plantillas;
  let p = enVuelo.get(storeId);
  if (!p) {
    p = (async () => {
      // ⛔ SIN `fase`. El servidor devuelve SIEMPRE la misma lista y lo único
      // que hace con la fase es ORDENARLA (`ordenarParaFase`, que es pura y ya
      // vive en el cliente). Cachear por (tienda, fase) significaba UNA llamada
      // de red a ImporChat POR CADA FASE del tablero —quince viajes para traer
      // exactamente las mismas 43 plantillas— y la asesora esperaba en cada
      // fase nueva que tocaba. Ahora es una sola por tienda y el orden se
      // calcula acá, gratis.
      const { data, error } = await supabase.functions.invoke('importchat-plantillas', {
        body: { store_id: storeId, accion: 'listar' },
      });
      if (error) throw error;
      const r = data as { ok?: boolean; plantillas?: PlantillaMeta[]; error?: string } | null;
      if (!r?.ok) throw new Error(r?.error || 'No se pudieron leer las plantillas');
      const lista = r.plantillas ?? [];
      // Solo se cachea el ÉXITO. Guardar una lista vacía por un error dejaría
      // "esta cuenta no tiene plantillas" pegado 5 minutos, que es una
      // afirmación falsa sobre la cuenta del cliente.
      cache.set(storeId, { at: Date.now(), plantillas: lista });
      return lista;
    })().finally(() => { enVuelo.delete(storeId); });
    enVuelo.set(storeId, p);
  }
  return p;
}

/**
 * Pide la lista ANTES de que nadie toque un botón.
 *
 * El tablero la llama al montarse: la llamada a ImporChat tarda lo que tarda,
 * pero ocurre mientras la asesora todavía está leyendo la pantalla, no cuando
 * ya apretó y está esperando. Nunca lanza — es una mejora de velocidad, no un
 * camino del que dependa nada.
 */
const falloReciente = new Map<string, number>();
const REINTENTO_MS = 60_000;

export function precargarPlantillas(storeId: string | null | undefined): void {
  if (!storeId) return;
  // ⛔ El fallo se recuerda un minuto. En una tienda SIN ImporChat (Colombia)
  // esta llamada falla siempre, y sin esto cada ida y vuelta entre pantallas
  // disparaba otro intento: el caché solo guarda el éxito, a propósito. Es solo
  // para la PREcarga — cuando la asesora toca el botón, se intenta igual.
  const ultimo = falloReciente.get(storeId);
  if (ultimo && Date.now() - ultimo < REINTENTO_MS) return;
  void traer(storeId).catch(() => { falloReciente.set(storeId, Date.now()); });
}

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
    // Lo cacheado se pinta SIN pasar por 'cargando': si ya está, la asesora no
    // tiene por qué ver un spinner. Ese parpadeo era la mitad de la sensación
    // de lentitud aunque la respuesta ya estuviera en memoria.
    const guardado = cache.get(activeStoreId);
    if (!forzar && guardado && Date.now() - guardado.at < CACHE_MS) {
      turnoRef.current += 1;
      setPlantillas(ordenarParaFase(guardado.plantillas, fase));
      setEstado('ok');
      setError(undefined);
      return;
    }
    if (forzar) cache.delete(activeStoreId);
    const turno = ++turnoRef.current;
    setEstado('cargando');
    setError(undefined);
    try {
      const lista = await traer(activeStoreId);
      if (turno !== turnoRef.current) return;
      setPlantillas(ordenarParaFase(lista, fase));
      setEstado('ok');
    } catch (e) {
      if (turno !== turnoRef.current) return;
      const { detalle, sinConfig } = await motivoReal(e, 'No se pudieron leer las plantillas');
      if (turno !== turnoRef.current) return;
      setEstado(sinConfig ? 'sin_config' : 'error');
      setError(sinConfig ? undefined : detalle);
      setPlantillas([]);
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
  /**
   * ⛔ El servidor dijo "ya se mandó antes hoy" y NO reenvió nada.
   *
   * `ok: true` significa "la operación terminó bien", NO "al cliente le llegó
   * un mensaje". El hook LEÍA `ya_enviado` (para no emitir la gestión
   * optimista) y lo DESCARTABA al devolver, así que río abajo los dos
   * consumidores trataban `ok:true` como envío real: toast verde «El cliente
   * ya lo recibió por WhatsApp» y la tarjeta pintada como gestionada, sobre un
   * mensaje que nunca salió. Es la misma regla que este repo escribió para
   * `importchat-send` —«un listo sin confirmar es peor que un error»— rota en
   * el camino de vuelta.
   *
   * El candado de un envío por día está BIEN. Lo que hay que arreglar es que
   * la pantalla afirme un envío que no ocurrió.
   */
  yaEnviado?: boolean;
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
          // Igual que en `useEnviarWhatsapp`: la fila la inserta el servidor, así
          // que este `at` es del navegador y no sirve para deduplicar contra el
          // realtime. Ver `eventosGestion.ts`.
          at: new Date().toISOString(),
          optimista: true,
        });
      }
      return { ok: true, yaEnviado: r.ya_enviado === true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'No se pudo enviar la plantilla' };
    } finally {
      setEnviando(false);
    }
  }, [activeStoreId, user]);

  return { enviarPlantilla, enviando };
}
