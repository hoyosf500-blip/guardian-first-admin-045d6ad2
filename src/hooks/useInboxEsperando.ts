import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { estadoConversacion } from '@/lib/actividadChat';

/**
 * La bandeja central: TODOS los clientes de la tienda que escribieron y nadie
 * les contestó — cruzando Confirmar y Seguimiento, en una sola lista.
 *
 * Nace de la regla del dueño ("que a todos se les llame/escriba, que nada se
 * enfríe") ahora que la mayoría del tráfico es inbound. Los chips "te escribió"
 * viven dispersos por tarjeta y por columna; con volumen alto hace falta UN lugar
 * que los junte y los ordene por quién lleva más esperando.
 *
 * "Esperando" = el último mensaje del chat es del CLIENTE (estadoConversacion
 * === 'espera_respuesta'). Se calcula con la MISMA función que los chips, para no
 * tener dos definiciones que se desincronicen.
 */

export interface InboxItem {
  dbId: string;
  externalId: string;
  nombre: string;
  phone: string;
  estado: string;
  ciudad: string | null;
  producto: string | null;
  valor: number | null;
  guia: string | null;
  transportadora: string | null;
  /** ms epoch del último mensaje del cliente (por eso está esperando). */
  entranteAt: number;
}

export type InboxStatus = 'cargando' | 'ok' | 'not_ready' | 'error';

// Estados terminales: un pedido entregado/cancelado no es una mano levantada que
// haya que atender ya. Se filtran client-side (los borrados incluidos).
const TERMINALES = new Set(['ENTREGADO', 'CANCELADO', 'ARCHIVADO GHOST', 'ARCHIVADO_GHOST']);

// Tope de la consulta: se traen las conversaciones con inbound MÁS RECIENTE y se
// filtra a las que esperan. Cubre la ventana de trabajo real; con volumen muy
// alto, una conversación que quedó esperando hace semanas podría caer fuera del
// tope — es una limitación conocida, no un cero silencioso.
const TOPE = 500;

export function useInboxEsperando(storeId: string | null) {
  const [items, setItems] = useState<InboxItem[]>([]);
  // Arranca en 'cargando', NO en 'ok': con 'ok'+vacío la pantalla afirmaría
  // "nadie esperando" sobre datos que todavía no llegaron (el bug de la casa).
  const [status, setStatus] = useState<InboxStatus>('cargando');
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!storeId) { setItems([]); setStatus('cargando'); return; }
    const seq = ++seqRef.current;
    const { data, error } = await supabase
      .from('orders')
      .select('id, external_id, nombre, phone, estado, ciudad, producto, valor, guia, transportadora, chat_entrante_at, chat_saliente_at, chat_leido_at')
      .eq('store_id', storeId)
      .not('chat_entrante_at', 'is', null)
      .order('chat_entrante_at', { ascending: false })
      .limit(TOPE);
    if (seq !== seqRef.current) return;
    if (error) {
      const code = (error as { code?: string }).code;
      const msg = (error as { message?: string }).message || '';
      // 42703 = la migración de columnas de chat no corrió: la función no está
      // prendida todavía, no es un error que avisar.
      setStatus(code === '42703' || /does not exist|column/i.test(msg) ? 'not_ready' : 'error');
      setItems([]);
      return;
    }
    type Fila = {
      id: string; external_id: string | null; nombre: string | null; phone: string | null;
      estado: string | null; ciudad: string | null; producto: string | null; valor: number | null;
      guia: string | null; transportadora: string | null;
      chat_entrante_at: string | null; chat_saliente_at: string | null; chat_leido_at: string | null;
    };
    const filas = (data ?? []) as unknown as Fila[];
    const out: InboxItem[] = [];
    for (const r of filas) {
      const entranteAt = r.chat_entrante_at ? Date.parse(r.chat_entrante_at) : null;
      if (entranteAt == null) continue;
      const estado = estadoConversacion({
        salienteAt: r.chat_saliente_at ? Date.parse(r.chat_saliente_at) : null,
        salienteTipo: null,
        entranteAt,
        leidoAt: r.chat_leido_at ? Date.parse(r.chat_leido_at) : Date.now(),
      });
      if (estado !== 'espera_respuesta') continue;
      if (TERMINALES.has((r.estado || '').toUpperCase().trim())) continue;
      out.push({
        dbId: String(r.id),
        externalId: r.external_id || '',
        nombre: r.nombre || 'Cliente',
        phone: r.phone || '',
        estado: r.estado || '',
        ciudad: r.ciudad,
        producto: r.producto,
        valor: r.valor != null ? Number(r.valor) : null,
        guia: r.guia,
        transportadora: r.transportadora,
        entranteAt,
      });
    }
    // Quien lleva MÁS esperando, primero: es a quien más urge no dejar enfriar.
    out.sort((a, b) => a.entranteAt - b.entranteAt);
    setItems(out);
    setStatus('ok');
  }, [storeId]);

  useEffect(() => { void load(); }, [load]);

  // Inbound EN VIVO: cuando un cliente escribe (o una asesora responde), la
  // bandeja se re-arma sola. Canal con id POR INSTANCIA (guardián canalRealtimeUnico).
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const instanciaId = useId();
  useEffect(() => {
    if (!storeId) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`inbox-espera-${instanciaId}-${storeId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `store_id=eq.${storeId}` },
        () => { if (t) clearTimeout(t); t = setTimeout(() => { void loadRef.current(); }, 1500); })
      .subscribe();
    return () => { if (t) clearTimeout(t); void supabase.removeChannel(ch); };
  }, [storeId, instanciaId]);

  return useMemo(() => ({ items, status, recargar: load }), [items, status, load]);
}
