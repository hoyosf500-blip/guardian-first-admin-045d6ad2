import { Radio, AlertTriangle, Loader2, MousePointerClick } from 'lucide-react';
import { useLiveTeam, type WorkStatus } from '@/hooks/useLiveTeam';

/**
 * Franja "Ahora mismo" — el pulso EN VIVO del equipo, embebido ARRIBA de
 * Productividad (solo cuando el rango es Hoy). Reemplaza la página /en-vivo que
 * existía aparte: era la MISMA información que Productividad ya muestra en
 * detalle, así que en vez de una pestaña separada, acá va lo único que
 * Productividad no tenía — quién está trabajando AHORA y qué hizo hace un rato,
 * sin preguntarle a nadie.
 *
 * Conciso a propósito: una línea por operadora (estado + última acción). El
 * detalle (jornada, horas, min/pedido, embudo) vive debajo, en las tablas de
 * Productividad. Se refresca solo (realtime + poll de 30s vía useLiveTeam).
 *
 * Honestidad: si la consulta falla se DICE ("no se pudo leer"), no se pinta un
 * cero que parezca medido.
 */

function hace(min: number | null): string {
  if (min == null) return '';
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h} h`;
}

const ESTADO: Record<WorkStatus, { label: string; dot: string; chip: string }> = {
  trabajando: { label: 'Trabajando', dot: 'bg-success', chip: 'bg-success/12 border-success/40 text-success' },
  presente_sin_marcar: { label: 'Presente sin marcar', dot: 'bg-warning', chip: 'bg-warning/12 border-warning/40 text-warning' },
  ausente: { label: 'Ausente', dot: 'bg-muted-foreground/40', chip: 'bg-muted/40 border-border text-muted-foreground' },
};

export default function TeamNowStrip() {
  const team = useLiveTeam();

  const trabajando = team.operators.filter(o => o.estado === 'trabajando').length;
  const sinMarcar = team.operators.filter(o => o.estado === 'presente_sin_marcar').length;

  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="hud-label text-accent flex items-center gap-1.5">
          <Radio size={12} className="text-success animate-pulse" aria-hidden="true" />
          Ahora mismo
        </div>
        {team.status === 'ok' && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap font-medium">
            <span className="text-success font-semibold">{trabajando} trabajando</span>
            {sinMarcar > 0 && <>· <span className="text-warning font-semibold">{sinMarcar} sin marcar</span></>}
            {team.pendingConfirmar != null && <>· {team.pendingConfirmar} por confirmar</>}
            {team.pendingNovedades != null && team.pendingNovedades > 0 && <>· {team.pendingNovedades} novedades</>}
          </p>
        )}
      </div>

      {team.status === 'error' && (
        <p className="text-xs text-danger flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          No se pudo leer la actividad en vivo. NO significa que no trabajaron: no se pudo consultar.
        </p>
      )}

      {team.status === 'loading' && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="animate-spin text-accent" size={16} aria-hidden="true" />
        </div>
      )}

      {team.status === 'ok' && (
        team.operators.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1">
            Todavía nadie registró trabajo hoy. Apenas alguien marque una gestión, aparece acá al instante.
          </p>
        ) : (
          <ul className="space-y-1">
            {team.operators.map((op) => {
              const est = ESTADO[op.estado];
              const ultima = op.ultimaAccion ? `${op.ultimaAccion} ${hace(op.lastWorkMin)}` : 'sin marcar hoy';
              return (
                <li
                  key={op.id}
                  className="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 hover:bg-muted/30 transition-colors"
                >
                  {/* Semáforo por ESTADO DE TRABAJO (no solo mouse): verde con
                      pulso = marcando ahora; ámbar = mouse activo pero sin marcar
                      (la señal de "parece ocupada, no trabaja"); gris = ausente. */}
                  <span className={`relative h-2.5 w-2.5 rounded-full shrink-0 ${est.dot}`} aria-hidden="true">
                    {op.estado === 'trabajando' && (
                      <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />
                    )}
                  </span>
                  <span className="text-sm font-semibold text-foreground truncate min-w-0 max-w-[10rem]" title={op.name}>
                    {op.name}
                  </span>
                  <span className={`hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-semibold shrink-0 ${est.chip}`}>
                    {est.label}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground min-w-0 flex-1 truncate">
                    <MousePointerClick size={11} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      <span className={op.ultimaAccion ? 'text-foreground font-medium' : ''}>{ultima}</span>
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-sm font-bold text-foreground shrink-0 ml-auto">
                    {op.total}
                    <span className="text-[9px] uppercase tracking-[0.06em] text-muted-foreground ml-1">hoy</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )
      )}

      {team.status === 'ok' && !team.presenceMouseOk && (
        <p className="text-[11px] text-warning">
          Presencia por actividad de mouse no disponible — se usa el trabajo marcado.
        </p>
      )}
    </section>
  );
}
