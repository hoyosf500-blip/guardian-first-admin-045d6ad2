import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useOrders } from '@/contexts/OrderContext';
import { TrendingUp, TrendingDown, Target } from 'lucide-react';
import { confRateOficial, confRateBySample, CONF_TARGET_PCT } from '@/lib/confirmationRate';

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

  // LA MATEMÁTICA OFICIAL (decisión del dueño 30-jul): confirmados ÷ GESTIONADOS
  // (conf+canc+noresp), meta 85%. Antes este banner usaba conf÷(conf+canc) (~99%)
  // y le decía "En meta" a la operadora mientras el Dashboard del dueño mostraba
  // 66% — la disputa del "Tasa: 99%". El cierre de llamada (÷contestaron) queda
  // como dato secundario en el tooltip, con su nombre.
  const cr = confRateOficial(data.confirmados, data.cancelados, data.noresp);
  const cierre = confRateBySample(data.confirmados, data.cancelados);
  const hasSample = !cr.inmaduro && cr.tasa != null;
  const tasa = cr.tasa ?? 0;

  let bg = 'bg-muted text-muted-foreground border-muted-foreground/20';
  let Icon = Target;
  let label = 'Calentando — aún no hay datos suficientes';

  // Meta oficial del dueño = CONF_TARGET_PCT (85%), fuente única. Verde en meta;
  // ámbar en la banda "cerca" (5 pts por debajo); rojo debajo de eso.
  if (hasSample) {
    if (tasa >= CONF_TARGET_PCT) {
      bg = 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30';
      Icon = TrendingUp;
      label = 'En meta';
    } else if (tasa >= CONF_TARGET_PCT - 5) {
      bg = 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30';
      Icon = TrendingDown;
      label = 'Cerca de la meta — subí el ritmo';
    } else {
      bg = 'bg-destructive/10 text-destructive border-destructive/30';
      Icon = TrendingDown;
      // La palanca real para subir esta tasa son los no-contesta (el cierre de
      // los que contestan ya suele ser ~99%): el label se lo recuerda.
      label = `Por debajo de la meta (${CONF_TARGET_PCT}%) — rescatá los "no contestó"`;
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
          <span
            className="font-mono text-base font-semibold"
            title={`Confirmación del día (tuya): ${data.confirmados} confirmados ÷ ${cr.gestionados} gestionados (incluye los ${data.noresp} que no contestaron — también son ventas por sacar). Meta ${CONF_TARGET_PCT}%.${cierre.tasa != null ? ` Tu cierre de llamada (de los que contestaron): ${cierre.tasa}%.` : ''}`}
          >
            {tasa}%
          </span>
          <span className="text-xs opacity-70">confirmación del día · meta {CONF_TARGET_PCT}%</span>
        </div>
      </div>
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}
