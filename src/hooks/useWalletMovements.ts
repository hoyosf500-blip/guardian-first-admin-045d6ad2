import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface WalletMovement {
  id: number;
  dropi_transaction_id: number;
  fecha: string;
  tipo: 'ENTRADA' | 'SALIDA' | string;
  codigo: string | null;
  categoria: string | null;
  monto: number;
  monto_previo: number | null;
  saldo_despues: number | null;
  descripcion: string | null;
  cuenta: string | null;
  concepto_retiro: string | null;
  related_order_id: string | null;
}

export interface UseWalletMovementsParams {
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  tipo?: 'ENTRADA' | 'SALIDA' | 'ALL';
  categoria?: string | 'ALL';
  page?: number;
  pageSize?: number;
}

export interface WalletMovementsResult {
  rows: WalletMovement[];
  total: number;
  ultimoSaldo: number | null;
  totalEntradas: number;
  totalSalidas: number;
  countTotal: number;
  categorias: string[];
}

export function useWalletMovements(params: UseWalletMovementsParams) {
  const { fromDate, toDate, tipo = 'ALL', categoria = 'ALL', page = 1, pageSize = 20 } = params;

  return useQuery<WalletMovementsResult>({
    queryKey: ['wallet_movements', fromDate, toDate, tipo, categoria, page, pageSize],
    queryFn: async () => {
      // Rango UTC inclusivo del día completo
      const fromTs = `${fromDate}T00:00:00Z`;
      const toTs = `${toDate}T23:59:59Z`;

      // 1. Página filtrada (con count exacto)
      let q = supabase
        .from('dropi_wallet_movements')
        .select('*', { count: 'exact' })
        .gte('fecha', fromTs)
        .lte('fecha', toTs)
        .order('fecha', { ascending: false });

      if (tipo !== 'ALL') q = q.eq('tipo', tipo);
      if (categoria !== 'ALL') q = q.eq('categoria', categoria);

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data, error, count } = await q;
      if (error) throw error;

      // 2. Agregados del rango completo (sin paginar, sin filtros tipo/categoria)
      const { data: aggData, error: aggError } = await supabase
        .from('dropi_wallet_movements')
        .select('tipo, monto, categoria, fecha, saldo_despues')
        .gte('fecha', fromTs)
        .lte('fecha', toTs)
        .order('fecha', { ascending: false })
        .limit(10000);
      if (aggError) throw aggError;

      let totalEntradas = 0;
      let totalSalidas = 0;
      const cats = new Set<string>();
      let ultimoSaldo: number | null = null;
      for (const r of aggData ?? []) {
        const m = Number(r.monto) || 0;
        if (r.tipo === 'ENTRADA') totalEntradas += m;
        else if (r.tipo === 'SALIDA') totalSalidas += m;
        if (r.categoria) cats.add(r.categoria);
        if (ultimoSaldo === null && r.saldo_despues !== null) {
          ultimoSaldo = Number(r.saldo_despues);
        }
      }

      return {
        rows: (data as WalletMovement[]) ?? [],
        total: count ?? 0,
        ultimoSaldo,
        totalEntradas,
        totalSalidas,
        countTotal: aggData?.length ?? 0,
        categorias: Array.from(cats).sort(),
      };
    },
    staleTime: 30_000,
  });
}

/** Series por día para la gráfica de barras apiladas. */
export function useWalletDailySeries(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ['wallet_daily_series', fromDate, toDate],
    queryFn: async () => {
      const fromTs = `${fromDate}T00:00:00Z`;
      const toTs = `${toDate}T23:59:59Z`;
      const { data, error } = await supabase
        .from('dropi_wallet_movements')
        .select('fecha, tipo, monto')
        .gte('fecha', fromTs)
        .lte('fecha', toTs)
        .limit(10000);
      if (error) throw error;

      const map = new Map<string, { fecha: string; ENTRADA: number; SALIDA: number }>();
      for (const r of data ?? []) {
        const day = String(r.fecha).slice(0, 10);
        const cur = map.get(day) ?? { fecha: day, ENTRADA: 0, SALIDA: 0 };
        const m = Number(r.monto) || 0;
        if (r.tipo === 'ENTRADA') cur.ENTRADA += m;
        else if (r.tipo === 'SALIDA') cur.SALIDA += m;
        map.set(day, cur);
      }
      return Array.from(map.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
    },
    staleTime: 30_000,
  });
}
