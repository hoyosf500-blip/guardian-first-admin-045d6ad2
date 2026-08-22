import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { normalizarRiesgo, type NivelRiesgo } from '@/lib/riesgoChat';

/**
 * Qué hizo el cliente con el botón de confirmar del WhatsApp, por pedido.
 *
 * Lo escribe la edge function `importchat-sync` en `orders.chat_riesgo`. Acá se
 * lee en UNA sola query (mismo molde que `useOrderNotesIndex`) y se devuelve un
 * Map por `dbId`.
 *
 * ── Por qué va en una query aparte y no en ORDER_COLUMNS ───────────────────
 * Lovable NO auto-aplica migraciones. Si `orderColumns.ts` nombrara una columna
 * que todavía no existe, el SELECT entero devuelve 42703 y se cae **toda**
 * pantalla que cargue pedidos — Confirmar, Seguimiento, Dashboard. Ya pasó y
 * está documentado en CLAUDE.md.
 *
 * Yendo aparte, el peor caso es que esta query falle sola: el estado queda en
 * `not_ready`, la cola sigue ordenándose como siempre y no se dibuja ningún
 * chip. La pantalla no se entera.
 */
export type RiesgoChatStatus = 'ok' | 'not_ready' | 'error';
export type RiesgoIndex = Map<string, NivelRiesgo>;

const VACIO: RiesgoIndex = new Map();

export interface RiesgoChatData {
  index: RiesgoIndex;
  status: RiesgoChatStatus;
  /** Cuántos de los pedidos consultados tienen la conversación ya leída. */
  leidos: number;
}

export function useRiesgoChat(storeId: string | null, orderIds: string[]): RiesgoChatData {
  const [index, setIndex] = useState<RiesgoIndex>(VACIO);
  const [status, setStatus] = useState<RiesgoChatStatus>('ok');
  const seqRef = useRef(0);

  // Firma estable: sin esto, cada refresh de realtime que reconstruye la cola
  // con los MISMOS pedidos dispararía la query de nuevo.
  const idsKey = orderIds.length === 0 ? '' : [...orderIds].sort().join(',');

  const load = useCallback(async () => {
    if (!storeId || !idsKey) { setIndex(VACIO); setStatus('ok'); return; }
    const seq = ++seqRef.current;
    const ids = idsKey.split(',');
    const { data, error } = await supabase
      .from('orders')
      .select('id, chat_riesgo, chat_leido_at')
      .eq('store_id', storeId)
      .in('id', ids);
    if (seq !== seqRef.current) return;

    if (error) {
      const code = (error as { code?: string }).code;
      const msg = (error as { message?: string }).message || '';
      // 42703 = la migración todavía no corrió. No es un error del que haya que
      // avisar a nadie: es una función que aún no está prendida.
      setStatus(code === '42703' || /does not exist|column/i.test(msg) ? 'not_ready' : 'error');
      setIndex(VACIO);
      return;
    }

    // `types.ts` se autogenera del esquema y todavía no conoce estas columnas
    // (la migración es nueva). El cast va por `unknown` y NO se toca el archivo
    // generado: regenerarlo a mano es justo lo que después Lovable pisa.
    type Fila = { id: string; chat_riesgo: unknown; chat_leido_at: string | null };
    const filas = (data ?? []) as unknown as Fila[];

    const m: RiesgoIndex = new Map();
    for (const row of filas) {
      // Sin `chat_leido_at` nadie miró esa conversación: no se guarda nada, y
      // el pedido queda sin chip. Un chip verde sobre un dato que no existe
      // sería peor que no tener chip.
      if (!row.chat_leido_at) continue;
      const n = normalizarRiesgo(row.chat_riesgo);
      if (n) m.set(String(row.id), n);
    }
    setIndex(m);
    setStatus('ok');
  }, [storeId, idsKey]);

  useEffect(() => { void load(); }, [load]);

  return useMemo(
    () => ({ index, status, leidos: index.size }),
    [index, status],
  );
}
