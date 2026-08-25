import { Gauge, TrendingUp } from 'lucide-react';
import type { Ritmo } from '@/lib/ritmoTurno';

/**
 * Velocímetro del turno: apura al asesor mostrándole su ritmo EN VIVO y si a ese
 * paso termina la cola. Presentacional puro (el hook useRitmoTurno calcula).
 *
 * Rojo cuando va lento — el atraso deja de ser invisible. Antes de 10 min no
 * presiona ("midiendo"): un ritmo sobre 3 gestiones sería mentira.
 */
function relojBogota(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString('es-CO', {
      timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return ''; }
}

export default function VelocimetroTurno({
  gestionados,
  faltan,
  ritmo,
}: {
  gestionados: number;
  faltan: number;
  ritmo: Ritmo & { nowMs: number };
}) {
  const { porHora, etaMin, vaLento, bajoOptimo, nowMs } = ritmo;

  // Todavía midiendo (primeros minutos): mostrar solo el avance, sin apurar.
  if (porHora == null) {
    return (
      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-border bg-card/40 px-3.5 py-2 text-xs text-muted-foreground">
        <Gauge size={15} aria-hidden="true" />
        <span>Llevás <strong className="text-foreground tabular-nums">{gestionados}</strong> · faltan <strong className="text-foreground tabular-nums">{faltan}</strong></span>
        <span className="opacity-70">· midiendo tu ritmo…</span>
      </div>
    );
  }

  const etaTxt = etaMin == null ? null
    : etaMin <= 0 ? '¡cola en cero!'
    : `terminás ~${relojBogota(nowMs + etaMin * 60_000)}`;

  // Tres niveles: verde ≥20/h (óptimo, 3 min) · ámbar 12-20 (podés ir más rápido) ·
  // rojo <12 (5 min, alerta de verdad). El óptimo se muestra siempre como meta.
  const marco = vaLento ? 'border-danger/50 bg-danger/10'
    : bajoOptimo ? 'border-warning/50 bg-warning/10'
    : 'border-success/40 bg-success/10';
  const acento = vaLento ? 'text-danger' : bajoOptimo ? 'text-warning' : 'text-success';

  return (
    <div className={`mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border-2 px-3.5 py-2 text-sm transition-colors ${marco}`}>
      <span
        className={`inline-flex items-center gap-1.5 font-bold ${acento}`}
        title="Óptimo: 20 pedidos por hora = 3 minutos por pedido. Entre 12 y 20 vas ámbar; por debajo de 12 (5 min/pedido) se pone rojo."
      >
        <Gauge size={16} aria-hidden="true" />
        <span className="tabular-nums text-base">{porHora}</span>
        <span className="text-xs font-semibold">/hora</span>
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="text-foreground">
        Llevás <strong className="tabular-nums">{gestionados}</strong> · faltan <strong className="tabular-nums">{faltan}</strong>
      </span>
      {etaTxt && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className={`inline-flex items-center gap-1 ${vaLento ? 'text-danger' : 'text-muted-foreground'}`}>
            <TrendingUp size={13} aria-hidden="true" />{etaTxt}
          </span>
        </>
      )}
      {vaLento ? (
        <span className="ml-auto rounded-lg bg-danger/20 px-2 py-0.5 text-[11px] font-bold text-danger">
          Acelerá — vas lento
        </span>
      ) : bajoOptimo ? (
        <span className="ml-auto rounded-lg bg-warning/20 px-2 py-0.5 text-[11px] font-bold text-warning">
          El óptimo es 20/h
        </span>
      ) : null}
    </div>
  );
}
