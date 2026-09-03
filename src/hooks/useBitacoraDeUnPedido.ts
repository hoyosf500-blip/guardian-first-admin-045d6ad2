import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { EventoPedido } from '@/lib/eventosPedido';

/**
 * La bitácora de UN pedido, en orden cronológico.
 *
 * `order_events` tiene índice por `(store_id, external_id, created_at)` desde
 * la migración del 3-sep-2026, y hasta el 4-sep ninguna pantalla lo usaba:
 * "¿se puede ver la bitácora completa de un pedido?" era que no. La RLS hace el
 * resto: la asesora ve lo suyo, el jefe ve todo.
 *
 * ⛔ `estado` explícito y `'cargando'` distinto de una lista vacía: sobre esto
 * se habla con una persona, y "todavía no llegó" no es "nadie lo tocó".
 */
export type EstadoBitacoraPedido = 'cargando' | 'ok' | 'not_ready' | 'error';

export interface EventoDeUnPedido {
  id: string;
  operatorId: string;
  evento: EventoPedido;
  detalle: Record<string, unknown>;
  msEnPantalla: number | null;
  createdAt: string;
}

/** Más que esto en un pedido es un bucle, no una historia. Y se dice. */
const TOPE = 500;

export function useBitacoraDeUnPedido(storeId: string | null, externalId: string | null | undefined) {
  const [eventos, setEventos] = useState<EventoDeUnPedido[]>([]);
  const [estado, setEstado] = useState<EstadoBitacoraPedido>('cargando');
  const [truncado, setTruncado] = useState(false);

  const cargar = useCallback(async () => {
    if (!storeId || !externalId) { setEventos([]); setEstado('cargando'); return; }
    setEstado('cargando');
    const { data, error } = await supabase
      .from('order_events')
      .select('id, operator_id, evento, detalle, ms_en_pantalla, created_at')
      .eq('store_id', storeId)
      .eq('external_id', String(externalId))
      .order('created_at', { ascending: true })
      .limit(TOPE + 1);
    if (error) {
      const code = (error as { code?: string }).code;
      const msg = (error as { message?: string }).message || '';
      setEstado(code === '42P01' || /does not exist|relation/i.test(msg) ? 'not_ready' : 'error');
      setEventos([]);
      return;
    }
    type Cruda = {
      id: string; operator_id: string; evento: string; detalle: unknown;
      ms_en_pantalla: number | null; created_at: string;
    };
    const crudas = ((data ?? []) as unknown as Cruda[]);
    setTruncado(crudas.length > TOPE);
    setEventos(crudas.slice(0, TOPE).map((r) => ({
      id: String(r.id),
      operatorId: String(r.operator_id),
      evento: r.evento as EventoPedido,
      detalle: (r.detalle && typeof r.detalle === 'object' ? r.detalle : {}) as Record<string, unknown>,
      msEnPantalla: r.ms_en_pantalla,
      createdAt: r.created_at,
    })));
    setEstado('ok');
  }, [storeId, externalId]);

  useEffect(() => { void cargar(); }, [cargar]);

  return { eventos, estado, truncado, recargar: cargar };
}
