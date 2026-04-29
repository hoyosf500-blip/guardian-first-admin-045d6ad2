import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useState, useCallback, useEffect } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';
import { calcPriority } from '@/lib/alertSystem';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { toast } from 'sonner';

/**
 * Smart merge: preserva la referencia de objetos que no cambiaron en campos
 * relevantes para que React no re-renderice las cards intactas durante
 * refreshes periódicos (cron Dropi cada 1 min). Esto elimina el "parpadeo".
 */
export function smartMerge(prev: OrderData[], next: OrderData[]): OrderData[] {
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map(o => [o.dbId || `${o.phone}|${o.idx}`, o]));
  let anyChanged = false;
  const merged = next.map(n => {
    const id = n.dbId || `${n.phone}|${n.idx}`;
    const old = prevById.get(id);
    if (!old) {
      anyChanged = true;
      return n;
    }
    const fieldsChanged = (
      old.estado !== n.estado ||
      old.assignedTo !== n.assignedTo ||
      old.lockedBy !== n.lockedBy ||
      old.lockedAt !== n.lockedAt ||
      old.diasConf !== n.diasConf ||
      old.dias !== n.dias ||
      old.novedad !== n.novedad ||
      old.novedadSol !== n.novedadSol ||
      old.guia !== n.guia ||
      old.transportadora !== n.transportadora
    );
    if (fieldsChanged) {
      anyChanged = true;
      return n;
    }
    return old;
  });
  // Si nada cambió y la cantidad coincide, devolver prev intacto para que
  // React no re-renderice (preserva scroll).
  if (!anyChanged && prev.length === next.length) {
    return prev;
  }
  return merged;
}

// Fix 22: lista explícita de columnas para queries de orders. Evita SELECT *
// que trae columnas innecesarias en cada fetch.
const ORDER_COLUMNS = 'id, external_id, nombre, phone, ciudad, departamento, producto, estado, fecha, fecha_conf, dias, dias_conf, valor, flete, costo_prod, costo_dev, cantidad, direccion, novedad, guia, transportadora, tags, tienda, novedad_sol, assigned_to, locked_by, locked_at, created_at, uploaded_by';

interface DataLoaderState {
  segData: OrderData[];
  setSegData: React.Dispatch<React.SetStateAction<OrderData[]>>;
  segLoaded: boolean;
  setSegLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  segLoading: boolean;
  segLastUpdate: Date | null;
  loadSegData: (force?: boolean) => Promise<void>;
}

export function useDataLoader(user: User | null): DataLoaderState {
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [segLoaded, setSegLoaded] = useState(false);
  const [segLoading, setSegLoading] = useState(false);
  const [segLastUpdate, setSegLastUpdate] = useState<Date | null>(null);

  const loadSegData = useCallback(async (force = false) => {
    if (!user) return;
    if (segLoaded && !force) return;
    setSegLoading(true);
    try {
      // Paginación: Supabase limita cada SELECT a ~1000 filas por defecto.
      // Leemos en páginas hasta completar o llegar a HARD_LIMIT — evita el
      // antiguo problema de "solo se ven los 5000 más recientes".
      const PAGE_SIZE = 1000;
      const HARD_LIMIT = 20000;
      type Row = Parameters<typeof dbToOrderData>[0];
      const all: Row[] = [];
      let fromIdx = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const toIdx = fromIdx + PAGE_SIZE - 1;
        const { data, error } = await supabase
          .from('orders')
          .select(ORDER_COLUMNS)
          .not('estado', 'eq', 'PENDIENTE CONFIRMACION')
          .not('estado', 'eq', 'ENTREGADO')
          .not('estado', 'eq', 'CANCELADO')
          .not('estado', 'eq', 'RECHAZADO')
          .not('estado', 'eq', 'DEVOLUCION')
          .not('estado', 'eq', 'DEVOLUCION EN TRANSITO')
          .not('estado', 'ilike', '%INDEMNIZADA%')
          .order('created_at', { ascending: false })
          .range(fromIdx, toIdx);
        if (error) {
          console.error('Error loading seg orders:', error);
          toast.error('Error cargando seguimiento: ' + error.message);
          return;
        }
        const rows = (data || []) as Row[];
        all.push(...rows);
        if (rows.length < PAGE_SIZE) break;
        if (all.length >= HARD_LIMIT) {
          toast.warning(`Se cargaron ${HARD_LIMIT} pedidos (tope máx). Pide a un admin subir el límite si faltan pedidos antiguos.`);
          break;
        }
        fromIdx += PAGE_SIZE;
      }
      const mapped = all.map((o, idx) => dbToOrderData(o, idx));
      mapped.sort((a, b) => calcPriority(b) - calcPriority(a));
      setSegData(prev => smartMerge(prev, mapped));
      setSegLastUpdate(new Date());
      setSegLoaded(true);
    } finally {
      setSegLoading(false);
    }
  }, [user, segLoaded]);

  // COST-1: auto-refresh cada 15 min y solo cuando la pestaña está visible.
  useEffect(() => {
    if (!user) return;
    return pollWhenVisible(() => {
      if (segLoaded) loadSegData(true);
    }, 15 * 60 * 1000, { runOnVisible: false });
  }, [user, segLoaded, loadSegData]);

  return {
    segData, setSegData, segLoaded, setSegLoaded, segLoading, segLastUpdate, loadSegData,
  };
}
