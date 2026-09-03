import { supabase } from '@/integrations/supabase/client';

/**
 * Por dónde se le escribe al cliente en cada tienda.
 *
 * Ecuador atiende por **ImporChat** y las dos de Colombia por **Chatea Pro**.
 * Las pantallas (leer el hilo, escribir, mandar plantilla) son las mismas; lo
 * único que cambia es a qué edge function se llama.
 *
 * ⛔ Por qué NO va en `StoreContext`. La consulta de `stores` de ese contexto es
 * la que sostiene la app entera: si le agrego `canal_chat` y la migración
 * todavía no se aplicó, el SELECT muere con «column does not exist» y **nadie
 * puede entrar**. Es exactamente el accidente que documenta CLAUDE.md con
 * `ORDER_COLUMNS`. Acá la consulta es aparte y si falla se cae al canal por
 * país, que hoy es la verdad — así el módulo funciona igual antes y después de
 * aplicar la migración.
 */
export type CanalChat = 'importchat' | 'chateapro';

/** Una consulta por tienda y por sesión; el canal no cambia mientras se trabaja. */
const cache = new Map<string, Promise<CanalChat>>();

/** Sin dato explícito, el país decide: EC → ImporChat, el resto → Chatea Pro. */
function porPais(countryCode: string | null | undefined): CanalChat {
  return String(countryCode || '').toUpperCase() === 'EC' ? 'importchat' : 'chateapro';
}

/**
 * @param countryCode país de la tienda si el llamador ya lo tiene
 *   (`activeStore.country_code`). Es lo que decide cuando la lectura falla.
 *   ⛔ Sin él, el `catch` devolvía `'importchat'` FIJO —contradiciendo su
 *   propio comentario— y encima quedaba cacheado toda la sesión: un fallo
 *   transitorio en una tienda de Colombia dejaba a la asesora llamando a
 *   `importchat-*` en una cuenta Chatea Pro, sin poder leer ni escribir un
 *   chat hasta recargar (4-sep-2026).
 */
export async function canalDeTienda(storeId: string, countryCode?: string | null): Promise<CanalChat> {
  const guardado = cache.get(storeId);
  if (guardado) return guardado;

  const p = (async (): Promise<CanalChat> => {
    try {
      const { data, error } = await supabase
        .from('stores')
        .select('canal_chat, country_code')
        .eq('id', storeId)
        .maybeSingle();
      if (error) throw error;
      const row = data as { canal_chat?: string | null; country_code?: string | null } | null;
      if (row?.canal_chat === 'importchat' || row?.canal_chat === 'chateapro') return row.canal_chat;
      return porPais(row?.country_code ?? countryCode);
    } catch (e) {
      // Sin la columna (migración sin aplicar) o sin red: el país decide.
      // Nunca se lanza: quedarse sin canal apagaría el botón de escribir, y
      // eso se lee como "está roto" en vez de "todavía no está configurado".
      // Y el fallo NO se cachea: el próximo llamador vuelve a preguntar.
      console.warn('[canalChat] no se pudo leer el canal de la tienda; decide el país:', e instanceof Error ? e.message : e);
      cache.delete(storeId);
      return porPais(countryCode);
    }
  })();

  cache.set(storeId, p);
  return p;
}

/**
 * El nombre de la edge function para esta tienda.
 *
 * `base` es la acción sin prefijo: 'chat' (leer), 'send' (escribir),
 * 'plantillas'. Las dos familias se llaman igual a propósito —
 * `importchat-chat` / `chateapro-chat`— para que agregar un tercer canal sea
 * una fila más y no otro `if` desparramado por los hooks.
 */
export async function fnCanal(storeId: string, base: 'chat' | 'send' | 'plantillas', countryCode?: string | null): Promise<string> {
  const canal = await canalDeTienda(storeId, countryCode);
  return `${canal}-${base}`;
}

/**
 * El `source` con el que ESTE canal escribe en `sync_logs`.
 *
 * ⛔ Vive acá y no en cada pantalla (3-sep-2026). El badge lo elegía bien, pero
 * `/inbox` llamaba a `useImporchatSyncHealth(activeStoreId)` **sin source**, o
 * sea contra `importchat-sync`. En Colombia esa consulta no devuelve ni una
 * fila —ese sync es de Ecuador—, el estado sale `never`, y el aviso «esta lista
 * puede estar incompleta» solo se enciende con `failing`/`critical`.
 *
 * Resultado: en Colombia **ese aviso no se encendía nunca**. Es exactamente la
 * red que existe para que un "Nadie esperando respuesta" no sea una mentira
 * tranquilizadora sobre un feed muerto — la misma pantalla que ya celebró un
 * cero sobre 39 clientes sin contestar.
 */
export function sourceSyncChat(canal: CanalChat | null): string {
  return canal === 'chateapro' ? 'chateapro-sync' : 'importchat-sync';
}

/** Solo para las pruebas: olvidar lo cacheado. */
export function _limpiarCacheCanal(): void {
  cache.clear();
}
