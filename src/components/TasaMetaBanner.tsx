import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useOrders } from '@/contexts/OrderContext';
import { TrendingUp, TrendingDown, Target } from 'lucide-react';

interface TasaRow {
  confirmados: number;
  cancelados: number;
  noresp: number;
  total: number;
  tasa_confirmacion: number;
}

export default function TasaMetaBanner() {
  const { counter } = useOrders();
  const [data, setData] = useState<TasaRow | null>(null);

  const load = useCallback(async () => {
    const { data: rows } = await (supabase.rpc as unknown as (
      fn: string
    ) => Promise<{ data: TasaRow[] | null; error: unknown }>)('operator_today_tasa');
    if (rows && rows[0]) setData(rows[0]);
  }, []);

  useEffect(() => {
    load();
  }, [load, counter.conf, counter.canc, counter.noresp]);

  // COST-1: subido de 2 min → 15 min y pausado cuando la pestaña está oculta.
  useEffect(() => {
    return pollWhenVisible(load, 15 * 60 * 1000, { runOnVisible: false });
  }, [load]);

  if (!data) return null;

  const hasSample = data.total >= 5;
  const tasa = data.tasa_confirmacion;

  let bg = 'bg-muted text-muted-foreground border-muted-foreground/20';
  let Icon = Target;
  let label = 'Calentando — aún no hay datos suficientes';

  if (hasSample) {
    if (tasa >= 70) {
      bg = 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30';
      Icon = TrendingUp;
      label = 'En meta';
    } else if (tasa >= 65) {
      bg = 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30';
      Icon = TrendingDown;
      label = 'Cerca de la meta — subí el ritmo';
    } else {
      bg = 'bg-destructive/10 text-destructive border-destructive/30';
      Icon = TrendingDown;
      label = 'Por debajo de la meta (70%)';
    }
  }

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${bg}`}>
      <div className="flex items-center gap-3">
        <Icon size={18} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs opacity-80">
            Hoy: <strong>{data.confirmados}</strong> conf · <strong>{data.cancelados}</strong> canc · <strong>{data.noresp}</strong> noresp
          </span>
          <span className="opacity-40">|</span>
          <span className="font-mono text-base font-semibold">{tasa}%</span>
          <span className="text-xs opacity-70">(meta 70%)</span>
        </div>
      </div>
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}
