import { useOrders } from '@/contexts/OrderContext';
import { CheckCircle2, XCircle, PhoneOff } from 'lucide-react';
import { CONF_TARGET_PCT, confRateBySample } from '@/lib/confirmationRate';

export default function CounterBar() {
  const { workQueue, counter } = useOrders();
  const total = counter.conf + counter.canc + counter.noresp;
  // Denominador = lo gestionado HOY + lo que queda en cola. Antes era solo
  // `workQueue.length`, que funcionaba mientras `counter` contaba únicamente
  // la sesión actual. Desde que el contador se hidrata con lo real del día
  // (OrderContext → today_call_stats), `total` incluye lo gestionado en
  // sesiones anteriores y `workQueue.length` es solo lo que FALTA: la barra
  // llegaba a mostrar "8 / 1". Sumar ambos da la carga real del día.
  const goal = total + workQueue.length;
  const pct = goal > 0 ? Math.min(100, Math.round(total / goal * 100)) : 0;
  // Tasa de confirmación MADURA: conf ÷ (conf+canc), SIN noresp en el denominador
  // (fuente única confirmationRate.ts). Antes se usaba conf÷(conf+canc+noresp),
  // fórmula diluida obsoleta que pintaba rojo un día con muchos N/R aunque la
  // confirmación real superara la meta. Solo decide el COLOR de la barra vs meta;
  // el conteo crudo mostrado sigue siendo cobertura (total/goal).
  const tasa = confRateBySample(counter.conf, counter.canc).tasa ?? 0;

  if (workQueue.length === 0) return null;

  // Color de la tasa de confirmación vs la meta oficial del dueño
  // (CONF_TARGET_PCT = 85%, fuente única). Verde en meta; ámbar en la banda
  // "cerca" (5 pts por debajo); rojo debajo de eso.
  const barTone =
    tasa >= CONF_TARGET_PCT ? 'bg-gradient-to-r from-success to-success/75'
    : tasa >= CONF_TARGET_PCT - 5 ? 'bg-gradient-to-r from-warning to-warning/75'
    : 'bg-gradient-to-r from-danger to-danger/75';

  const pctBadge =
    pct >= 80 ? 'bg-success/12 text-success border-success/25'
    : pct >= 50 ? 'bg-warning/12 text-warning border-warning/25'
    : 'bg-muted/60 text-muted-foreground border-border';

  return (
    <div className="bg-card border border-border rounded-2xl p-3.5 mb-4 flex items-center gap-4 shadow-ds-xs">
      {/* Estos números son de TODA la tienda (todas las operadoras), NO personales
          — se etiqueta para no confundir con el banner personal "tu día". */}
      <span className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground shrink-0 hidden sm:inline">
        Equipo hoy
      </span>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm" aria-label={`Confirmados: ${counter.conf}`}>
          <div className="w-6 h-6 rounded-lg bg-success/12 border border-success/25 flex items-center justify-center">
            <CheckCircle2 size={13} className="text-success" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{counter.conf}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" aria-label={`Cancelados: ${counter.canc}`}>
          <div className="w-6 h-6 rounded-lg bg-danger/12 border border-danger/25 flex items-center justify-center">
            <XCircle size={13} className="text-danger" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{counter.canc}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" aria-label={`No respondió: ${counter.noresp}`}>
          <div className="w-6 h-6 rounded-lg bg-muted/60 border border-border flex items-center justify-center">
            <PhoneOff size={13} className="text-muted-foreground" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{counter.noresp}</span>
        </div>
      </div>
      <div
        className="flex-1 h-2 bg-muted/60 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Progreso: ${pct}%`}
      >
        <div
          className={`h-full rounded-full ${barTone} transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <span className="font-mono font-bold text-foreground tabular-nums">{total}</span>
        <span className="text-muted-foreground text-xs tabular-nums">/{goal}</span>
        <span className={`text-[11px] font-semibold ml-1 px-1.5 py-0.5 rounded-md border tabular-nums ${pctBadge}`}>
          {pct}%
        </span>
      </div>
    </div>
  );
}
