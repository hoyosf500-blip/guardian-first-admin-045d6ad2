import { useOperatorNames } from '@/hooks/useOperatorNames';
import { porcentajeDificiles, type MezclaAsesor } from '@/lib/mezclaAsesor';

/**
 * "Qué tipo de pedidos gestionó cada asesor hoy" — panel anti-descreme.
 * Presentacional: recibe la mezcla ya calculada (`useMezclaAsesor`).
 *
 * Muestra por asesor una barra: difíciles (rojo, hay que convencer) vs fáciles
 * (verde, el cliente ya dijo que sí) vs sin leer (gris). Un asesor que solo
 * agarra verde está descremando. El % de difíciles lo resume.
 *
 * ⚠️ El copy deja claro que es para MIRAR, no una condena: si la cola era toda
 * "ya confirmó", no había difíciles que atacar.
 */
export default function MezclaTrabajoPanel({
  mezcla,
  loading,
  error,
}: {
  mezcla: Map<string, MezclaAsesor>;
  loading: boolean;
  error: boolean;
}) {
  const { nameOf } = useOperatorNames();

  if (error) {
    return (
      <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-xs text-warning" role="status">
        No se pudo leer la mezcla de trabajo por asesor. Recargá para reintentar.
      </div>
    );
  }

  const filas = [...mezcla.entries()]
    .filter(([, m]) => m.total > 0)
    .sort(([, a], [, b]) => b.total - a.total);

  if (!loading && filas.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
        Todavía nadie gestionó pedidos hoy.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 px-4 py-3.5 shadow-card3d hairline-top">
      <div className="flex items-baseline justify-between mb-1">
        <h4 className="text-sm font-semibold text-foreground">Qué tipo de pedidos gestionó cada asesor</h4>
        <span className="hud-label text-muted-foreground">hoy</span>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">
        <span className="text-danger font-semibold">Difíciles</span> = hay que llamar y convencer ·{' '}
        <span className="text-success font-semibold">Fáciles</span> = el cliente ya apretó “confirmar”. Quien solo
        agarra fáciles está descremando — pero mirá primero cómo venía la cola.
      </p>

      <div className="space-y-2.5">
        {filas.map(([opId, m]) => {
          const otros = m.sin_dato + m.sinSenal;
          const pct = porcentajeDificiles(m);
          const w = (n: number) => (m.total > 0 ? `${(n / m.total) * 100}%` : '0%');
          const tonePct = pct == null ? 'text-muted-foreground' : pct >= 50 ? 'text-success' : pct >= 25 ? 'text-warning' : 'text-danger';
          return (
            <div key={opId} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-xs font-medium text-foreground" title={nameOf(opId)}>
                {nameOf(opId)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/40" role="img"
                  aria-label={`${m.dificiles} difíciles, ${m.faciles} fáciles, ${otros} sin leer`}>
                  {m.dificiles > 0 && <div className="bg-danger h-full" style={{ width: w(m.dificiles) }} title={`${m.dificiles} difíciles (llamar/convencer)`} />}
                  {m.faciles > 0 && <div className="bg-success h-full" style={{ width: w(m.faciles) }} title={`${m.faciles} fáciles (ya confirmó)`} />}
                  {otros > 0 && <div className="bg-muted-foreground/40 h-full" style={{ width: w(otros) }} title={`${otros} sin leer / sin señal`} />}
                </div>
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground w-24 text-right">
                <span className="text-danger font-bold">{m.dificiles}</span> díf ·{' '}
                <span className="text-success font-bold">{m.faciles}</span> fác
              </span>
              <span className={`shrink-0 text-xs font-bold tabular-nums w-12 text-right ${tonePct}`}
                title={pct == null ? 'Sin pedidos clasificables (todos sin leer)' : `${pct}% de lo clasificable fue difícil`}>
                {pct == null ? '—' : `${pct}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
