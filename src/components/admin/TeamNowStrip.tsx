import { Radio, AlertTriangle, Loader2, MousePointerClick, Gauge, LogIn } from 'lucide-react';
import { useLiveTeam, type WorkStatus } from '@/hooks/useLiveTeam';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { useStoreSchedule } from '@/hooks/useStoreSchedule';
import { scheduleFromMinutes, DEFAULT_SCHEDULE, bogotaSecondsOfDay } from '@/lib/inactivityWindow';
import { ritmoVivo, entroTarde, serieHoraria, RITMO_VIVO_META, RITMO_VIVO_ALERTA } from '@/lib/ritmoEnVivo';

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

function relojBogota(ms: number | null): string {
  if (ms == null) return '';
  try {
    return new Date(ms).toLocaleTimeString('es-CO', {
      timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return ''; }
}

/** Barritas de gestiones por hora del turno (una por hora del día). Alto ∝
 *  cantidad; hora vacía = barrita mínima gris. Puramente visual (aria-hidden). */
function BarritasHora({ serie }: { serie: { hora: number; cantidad: number }[] }) {
  if (serie.length === 0) return null;
  const max = Math.max(1, ...serie.map((s) => s.cantidad));
  return (
    <span className="inline-flex items-end gap-[2px] h-5" role="img" aria-label="Gestiones por hora">
      {serie.map((s) => {
        const px = s.cantidad === 0 ? 2 : Math.max(3, Math.round((s.cantidad / max) * 20));
        return (
          <span
            key={s.hora}
            className={`w-[4px] rounded-sm ${s.cantidad === 0 ? 'bg-muted-foreground/25' : 'bg-accent/70'}`}
            style={{ height: `${px}px` }}
            title={`${s.hora}:00 — ${s.cantidad} ${s.cantidad === 1 ? 'gestión' : 'gestiones'}`}
          />
        );
      })}
    </span>
  );
}

const ESTADO: Record<WorkStatus, { label: string; dot: string; chip: string }> = {
  trabajando: { label: 'Trabajando', dot: 'bg-success', chip: 'bg-success/12 border-success/40 text-success' },
  presente_sin_marcar: { label: 'Presente sin marcar', dot: 'bg-warning', chip: 'bg-warning/12 border-warning/40 text-warning' },
  ausente: { label: 'Ausente', dot: 'bg-muted-foreground/40', chip: 'bg-muted/40 border-border text-muted-foreground' },
};

export default function TeamNowStrip() {
  const team = useLiveTeam();
  const activeStoreId = useActiveStoreId();
  const { data: scheduleMin } = useStoreSchedule(activeStoreId);
  const schedule = scheduleMin ? scheduleFromMinutes(scheduleMin) : DEFAULT_SCHEDULE;
  const nowMs = Date.now();
  const startHour = Math.floor(schedule.workStartSec / 3600);
  const nowHour = Math.floor(bogotaSecondsOfDay(new Date(nowMs)) / 3600);

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
            {team.workEventsOk ? (
              <>
                <span className="text-success font-semibold">{trabajando} trabajando</span>
                {sinMarcar > 0 && <>· <span className="text-warning font-semibold">{sinMarcar} sin marcar</span></>}
              </>
            ) : (
              <span className="text-warning font-semibold">quién trabaja: sin dato</span>
            )}
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

      {/* Hueco de LECTURA, no de trabajo: sin las marcas de hoy TODO el equipo
          cae a 'Ausente' / 'sin marcar'. Se avisa ARRIBA de la lista para que
          nadie reclame por un estado que no se pudo medir. Los números del día
          NO se ven afectados: salen de la RPC de productividad. */}
      {team.status === 'ok' && !team.workEventsOk && (
        <p className="text-xs text-warning flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          No se pudo leer la actividad de hoy: los estados y la última acción de abajo están
          incompletos — NO significa que no trabajaron. Los totales del día sí son reales.
        </p>
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
              // Sin la lectura de gestiones, "sin marcar hoy" sería una
              // afirmación que no se midió: se dice que falta el dato.
              const ultima = op.ultimaAccion
                ? `${op.ultimaAccion} ${hace(op.lastWorkMin)}`
                : (team.workEventsOk ? 'sin marcar hoy' : 'sin dato de actividad');
              // Velocidad EN VIVO con la vara estricta del dueño (25/15). null si
              // aún es muy temprano para medir (primeros 10 min) o no marcó nada.
              const ritmo = op.firstSignalMs != null
                ? ritmoVivo({ gestionados: op.total, desdeMs: op.firstSignalMs, nowMs, faltan: 0 })
                : null;
              const tarde = op.firstSignalMs != null
                && entroTarde(bogotaSecondsOfDay(new Date(op.firstSignalMs)), schedule.workStartSec);
              const serie = serieHoraria(op.hourly, startHour, Math.max(startHour, nowHour));
              return (
                <li
                  key={op.id}
                  className="rounded-xl px-2.5 py-1.5 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
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
                    <span
                      className={`hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-semibold shrink-0 ${est.chip} ${team.workEventsOk ? '' : 'opacity-50'}`}
                      title={team.workEventsOk ? undefined : 'Estado incompleto: no se pudo leer la actividad de hoy'}
                    >
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
                  </div>

                  {/* Segunda línea EN VIVO: velocidad (vara estricta) · hora de
                      entrada con 'tarde' · barritas por hora. Solo si hay una
                      primera señal del día — sin dato no se dibuja (no acusa). */}
                  {op.firstSignalMs != null && (
                    <div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap pl-5 text-[11px]">
                      {ritmo?.porHora != null ? (
                        <span
                          className={`inline-flex items-center gap-1 font-semibold ${
                            ritmo.vaLento ? 'text-danger' : ritmo.bajoOptimo ? 'text-warning' : 'text-success'
                          }`}
                          title={`Velocidad ahora. Óptimo ${RITMO_VIVO_META}/h · se pinta rojo bajo ${RITMO_VIVO_ALERTA}/h (vara estricta del dueño).`}
                        >
                          <Gauge size={12} aria-hidden="true" />
                          <span className="tabular-nums">{ritmo.porHora}/h</span>
                          {/* Cue NO-color (regla color-not-only): sin esto, ámbar y
                              verde solo se distinguían por el color. */}
                          {ritmo.vaLento ? <span>· lento</span> : ritmo.bajoOptimo ? <span>· sube</span> : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground inline-flex items-center gap-1">
                          <Gauge size={12} aria-hidden="true" /> midiendo ritmo…
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center gap-1 ${tarde ? 'text-danger font-semibold' : 'text-muted-foreground'}`}
                        title={tarde ? 'Entró tarde respecto al horario de la tienda.' : 'Hora de la primera señal del día (cuándo se conectó).'}
                      >
                        <LogIn size={12} aria-hidden="true" />
                        entró {relojBogota(op.firstSignalMs)}{tarde && ' · tarde'}
                      </span>
                      <BarritasHora serie={serie} />
                    </div>
                  )}
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
