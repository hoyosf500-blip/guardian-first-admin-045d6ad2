import { useOrders } from '@/contexts/OrderContext';
import { CheckCircle2, XCircle, PhoneOff } from 'lucide-react';
import { CONF_TARGET_PCT, confRateOficial } from '@/lib/confirmationRate';

export default function CounterBar() {
  const { workQueue, counter, counterCargado } = useOrders();
  // ⛔ `counterCargado` existía desde agosto con CERO consumidores (4-sep-2026).
  // Si la siembra del contador falla (RLS, red), `counter` queda en 0/0/0 y
  // esta barra rotulaba "Equipo hoy 0 · 0 · 0" con cara de dato medido — y es
  // el número que la operadora firma en el cierre del día. Sin lectura buena,
  // se pinta "—".
  const n = (v: number) => (counterCargado ? String(v) : '—');
  const total = counter.conf + counter.canc + counter.noresp;
  // Denominador = lo gestionado HOY + lo que queda SIN RESULTADO en la cola.
  // Los "no contestó" siguen en la cola para reintento pero YA están contados en
  // `total` — sumarlos de nuevo (workQueue.length completo) los contaba DOS veces
  // y la barra jamás llegaba a 100% aunque no quedara nada por hacer
  // (desmoralizante para la operadora, auditoría 30-jul).
  const pendSinResultado = workQueue.filter(o => !o.result).length;
  const goal = total + pendSinResultado;
  const pct = goal > 0 ? Math.min(100, Math.round(total / goal * 100)) : 0;
  // LA MATEMÁTICA OFICIAL (decisión del dueño 30-jul): confirmados ÷ GESTIONADOS
  // (conf+canc+noresp), meta 85%. Antes el color usaba conf÷(conf+canc) (~99%,
  // el "cierre de llamada") y la barra se pintaba verde mientras el Dashboard
  // decía 66% — la disputa del "Tasa: 99%". Solo decide el COLOR de la barra;
  // el ancho sigue siendo cobertura (total/goal).
  // `tasa` viene null sin gestiones. null NO es 0%: es "todavía no hay con qué
  // medir". Se conserva null a propósito — ver barTone.
  const { tasa } = confRateOficial(counter.conf, counter.canc, counter.noresp);

  if (workQueue.length === 0) return null;

  // Color de la tasa de confirmación vs la meta oficial del dueño
  // (CONF_TARGET_PCT = 85%, fuente única). Verde en meta; ámbar en la banda
  // "cerca" (5 pts por debajo); rojo debajo de eso.
  //
  // Sin resueltos (tasa === null) el color queda NEUTRO. Antes había un `?? 0`
  // que convertía "no hay dato" en 0% y caía en la rama roja = "por debajo de la
  // meta": un juicio de desempeño emitido antes de la primera llamada del día,
  // sobre cero información. Y justo ahí se ve seguro, porque el guard de arriba
  // (`workQueue.length === 0`) garantiza que la barra se muestra cuando HAY cola
  // pendiente — es decir, al abrir la jornada.
  // OJO: un 0% MEDIDO (hubo cancelaciones y ninguna confirmación) sigue en rojo.
  // Eso es un dato real, no un hueco — cero medido y dato ausente son distintos.
  const barTone =
    tasa === null ? 'bg-muted-foreground/40'
    : tasa >= CONF_TARGET_PCT ? 'bg-gradient-to-r from-success to-success/75'
    : tasa >= CONF_TARGET_PCT - 5 ? 'bg-gradient-to-r from-warning to-warning/75'
    : 'bg-gradient-to-r from-danger to-danger/75';

  const pctBadge =
    pct >= 80 ? 'bg-success/12 text-success border-success/25'
    : pct >= 50 ? 'bg-warning/12 text-warning border-warning/25'
    : 'bg-muted/60 text-muted-foreground border-border';

  return (
    <div className="bg-card border border-border rounded-2xl p-3.5 mb-4 flex items-center gap-4 shadow-card3d">
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
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{n(counter.conf)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" aria-label={`Cancelados: ${counter.canc}`}>
          <div className="w-6 h-6 rounded-lg bg-danger/12 border border-danger/25 flex items-center justify-center">
            <XCircle size={13} className="text-danger" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{n(counter.canc)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" aria-label={`No respondió: ${counter.noresp}`}>
          <div className="w-6 h-6 rounded-lg bg-muted/60 border border-border flex items-center justify-center">
            <PhoneOff size={13} className="text-muted-foreground" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{n(counter.noresp)}</span>
        </div>
      </div>
      <div
        className="flex-1 h-2 bg-muted/60 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Progreso: ${pct}%`}
        // El color de la barra codifica la tasa de confirmación (métrica distinta
        // del ancho, que es cobertura). No estaba rotulada en ningún lado: se
        // explica acá, incluido el caso "todavía no hay tasa". `aria-label` manda
        // sobre `title` para el nombre accesible, así que no se pisa nada.
        title={tasa === null
          ? 'Sin gestiones todavía: aún no hay confirmación del día que medir'
          : `Confirmación del día del equipo: ${tasa}% (${counter.conf} confirmados ÷ ${total} gestionados · meta ${CONF_TARGET_PCT}%). Incluye los "no contestó": también son ventas por sacar.`}
      >
        <div
          className={`h-full rounded-full ${barTone} transition-[width] duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <span className="font-mono font-bold text-foreground tabular-nums">{n(total)}</span>
        <span className="text-muted-foreground text-xs tabular-nums">/{counterCargado ? goal : '—'}</span>
        <span className={`text-[11px] font-semibold ml-1 px-1.5 py-0.5 rounded-md border tabular-nums ${counterCargado ? pctBadge : 'bg-muted/60 text-muted-foreground border-border'}`}
          title={counterCargado ? undefined : 'Todavía no se pudo leer el contador del día'}>
          {counterCargado ? `${pct}%` : '—'}
        </span>
      </div>
    </div>
  );
}
