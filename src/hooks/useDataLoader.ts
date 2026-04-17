import { useState, useCallback, useEffect } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData, isDespachado } from '@/lib/orderUtils';
import { calcPriority } from '@/lib/alertSystem';
import { toast } from 'sonner';

interface DataLoaderState {
  segData: OrderData[];
  setSegData: React.Dispatch<React.SetStateAction<OrderData[]>>;
  segLoaded: boolean;
  setSegLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  segLoading: boolean;
  segLastUpdate: Date | null;
  loadSegData: (force?: boolean) => Promise<void>;
  resData: OrderData[];
  setResData: React.Dispatch<React.SetStateAction<OrderData[]>>;
  resLoaded: boolean;
  setResLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  resLoading: boolean;
  loadResData: (force?: boolean) => Promise<void>;
}

export function useDataLoader(user: User | null): DataLoaderState {
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [segLoaded, setSegLoaded] = useState(false);
  const [segLoading, setSegLoading] = useState(false);
  const [segLastUpdate, setSegLastUpdate] = useState<Date | null>(null);
  const [resData, setResData] = useState<OrderData[]>([]);
  const [resLoaded, setResLoaded] = useState(false);
  const [resLoading, setResLoading] = useState(false);

  const loadSegData = useCallback(async (force = false) => {
    if (!user) return;
    if (segLoaded && !force) return;
    setSegLoading(true);
    try {
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { data: dbOrders, error } = await supabase
        .from('orders')
        .select('*')
        .not('estado', 'eq', 'PENDIENTE CONFIRMACION')
        .or(`locked_by.is.null,locked_by.eq.${user.id},locked_at.lt.${fifteenMinAgo}`)
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) {
        console.error('Error loading seg orders:', error);
        toast.error('Error cargando seguimiento: ' + error.message);
        return;
      }
      if (dbOrders) {
        if (dbOrders.length === 5000) {
          toast.warning('Se cargaron 5000 pedidos (límite máximo). Algunos pedidos antiguos pueden no mostrarse.');
        }
        const mapped = dbOrders.map((o, idx) => dbToOrderData(o, idx));
        mapped.sort((a, b) => calcPriority(b) - calcPriority(a));
        setSegData(mapped);
      }
      setSegLastUpdate(new Date());
      setSegLoaded(true);
    } finally {
      setSegLoading(false);
    }
  }, [user, segLoaded]);

  const loadResData = useCallback(async (force = false) => {
    if (!user) return;
    if (resLoaded && !force) return;
    setResLoading(true);
    try {
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { data: dbOrders, error } = await supabase
        .from('orders')
        .select('*')
        .not('estado', 'eq', 'PENDIENTE CONFIRMACION')
        .not('estado', 'eq', 'ENTREGADO')
        .not('estado', 'eq', 'CANCELADO')
        .or(`locked_by.is.null,locked_by.eq.${user.id},locked_at.lt.${fifteenMinAgo}`)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) {
        console.error('Error loading rescue orders:', error);
        toast.error('Error cargando rescate: ' + error.message);
        return;
      }
      if (dbOrders) {
        const orders = dbOrders
          .map((o, idx) => dbToOrderData(o, idx))
          .filter(o => {
            const e = o.estado.toUpperCase();
            const diasT = o.diasConf || o.dias;
            return (isDespachado(e) && diasT >= 5) ||
              (e.includes('NOVEDAD') && !o.novedadSol) ||
              e.includes('OFICINA') || e.includes('RECLAME') ||
              e.includes('DEVOL');
          });
        orders.sort((a, b) => calcPriority(b) - calcPriority(a));
        setResData(orders);
      }
      setResLoaded(true);
    } finally {
      setResLoading(false);
    }
  }, [user, resLoaded]);

  // Auto-refresh every 5 min after initial load
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      if (segLoaded) loadSegData(true);
      if (resLoaded) loadResData(true);
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user, segLoaded, resLoaded, loadSegData, loadResData]);

  return {
    segData, setSegData, segLoaded, setSegLoaded, segLoading, segLastUpdate, loadSegData,
    resData, setResData, resLoaded, setResLoaded, resLoading, loadResData,
  };
}
