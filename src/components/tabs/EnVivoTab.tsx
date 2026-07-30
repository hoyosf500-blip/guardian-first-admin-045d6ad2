import { motion } from 'framer-motion';
import {
  Activity, Phone, Package, AlertTriangle, CheckCircle2, Radio, Loader2, MousePointerClick,
} from 'lucide-react';
import { useLiveTeam, type LiveOperator, type WorkStatus } from '@/hooks/useLiveTeam';
import { TiltCard, CountUp } from '@/components/ui3d';

/**
 * Panel "En vivo" (/en-vivo): cómo va el equipo HOY sin preguntarle a nadie.
 * Por operadora, las tres colas (Confirmar / Seguimiento / Novedades) con lo
 * gestionado hoy, quién está en línea AHORA, y el backlog compartido de la
 * tienda. Se refresca solo (realtime + poll de 30s). Gated managerOnly.
 *
 * Honestidad de datos (igual que el resto del CRM): 'error' se dice, no se
 * pinta un cero que parezca medido; los pendientes que no se pudieron leer
 * muestran '—', no 0.
 */

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, delay, ease: 'easeOut' as const },
});

function hace(min: number | null): string {
  if (min == null) return '';
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h} h`;
}

/** Estilo del chip de estado de trabajo. */
const ESTADO: Record<WorkStatus, { label: string; dot: string; text: string; chip: string }> = {
  trabajando: { label: 'Trabajando', dot: 'bg-success', text: 'text-success', chip: 'bg-success/12 border-success/40 text-success' },
  presente_sin_marcar: { label: 'Presente sin marcar', dot: 'bg-warning', text: 'text-warning', chip: 'bg-warning/12 border-warning/40 text-warning' },
  ausente: { label: 'Ausente', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground', chip: 'bg-muted/40 border-border text-muted-foreground' },
};

/** Mini-columna de una cola: ícono + cifra grande + rótulo. */
function ColaStat({ icon: Icon, label, value, tone }: {
  icon: typeof Phone; label: string; value: number; tone: 'accent' | 'info' | 'warning';
}) {
  const toneMap = {
    accent: 'text-accent bg-accent/12 border-accent/30',
    info: 'text-info bg-info/12 border-info/30',
    warning: 'text-warning bg-warning/12 border-warning/30',
  } as const;
  return (
    <div className="flex-1 min-w-0 flex flex-col items-center gap-1 py-1">
      <span className={`w-7 h-7 rounded-lg border inline-flex items-center justify-center ${toneMap[tone]}`}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <span className="font-mono tabular-nums text-lg font-bold text-foreground leading-none">
        <CountUp value={value} />
      </span>
      <span className="text-[9px] uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
    </div>
  );
}

function OperatorCard({ op }: { op: LiveOperator }) {
  const est = ESTADO[op.estado];
  // Qué está haciendo AHORA: última acción + hace cuánto. Es el "sin preguntar".
  const ultima = op.ultimaAccion
    ? `${op.ultimaAccion} ${hace(op.lastWorkMin)}`
    : 'sin marcar hoy';
  return (
    <TiltCard
      sheen
      wrapperClassName="w-full"
      className="bg-card/40 border border-border rounded-2xl p-4 shadow-card3d h-full"
    >
      <div className="flex items-center gap-2.5 mb-2.5">
        {/* Semáforo por ESTADO de trabajo (no solo mouse) */}
        <span className={`relative h-2.5 w-2.5 rounded-full shrink-0 ${est.dot}`} aria-hidden="true">
          {op.estado === 'trabajando' && <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />}
        </span>
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-foreground truncate leading-tight" title={op.name}>
            {op.name}
          </span>
          <span className={`inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold ${est.chip}`}>
            {est.label}
          </span>
        </div>
        <div className="text-right shrink-0">
          <span className="font-mono tabular-nums text-base font-extrabold text-foreground leading-none">
            <CountUp value={op.total} />
          </span>
          <span className="block text-[9px] uppercase tracking-[0.06em] text-muted-foreground">hoy</span>
        </div>
      </div>

      {/* Última acción — qué hizo lo último y cuándo. */}
      <div className="flex items-center gap-1.5 mb-2.5 text-[11px] text-muted-foreground">
        <MousePointerClick size={11} className="shrink-0" aria-hidden="true" />
        <span className="truncate">
          Último: <span className={op.ultimaAccion ? 'text-foreground font-medium' : ''}>{ultima}</span>
        </span>
      </div>

      <div className="flex items-stretch gap-1 rounded-xl bg-muted/20 border border-border/60 divide-x divide-border/50">
        <ColaStat icon={Phone} label="Confirmar" value={op.confirmar} tone="accent" />
        <ColaStat icon={Package} label="Seguim." value={op.seguimiento} tone="info" />
        <ColaStat icon={AlertTriangle} label="Noved." value={op.novedades} tone="warning" />
      </div>
    </TiltCard>
  );
}

/** Tonos ESCRITOS COMPLETOS: Tailwind purga cualquier `text-${x}` armado en
 *  runtime, así que las clases van literales. */
const BACKLOG_TONE = {
  neutral: { num: 'text-muted-foreground', box: 'text-muted-foreground bg-muted/40 border-border' },
  success: { num: 'text-success', box: 'text-success bg-success/12 border-success/30' },
  warning: { num: 'text-warning', box: 'text-warning bg-warning/12 border-warning/30' },
  danger: { num: 'text-danger', box: 'text-danger bg-danger/12 border-danger/30' },
} as const;

/** Ficha del backlog compartido de la tienda. */
function BacklogTile({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: number | null }) {
  const tone = value == null ? 'neutral'
    : value === 0 ? 'success'
    : value >= 20 ? 'danger' : 'warning';
  const skin = BACKLOG_TONE[tone];
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card/40 px-4 py-3 shadow-card3d flex-1 min-w-[150px]">
      <span className={`w-9 h-9 rounded-xl inline-flex items-center justify-center border ${skin.box}`}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <span className={`font-mono tabular-nums text-xl font-extrabold leading-none block ${skin.num}`}>
          {value == null ? '—' : <CountUp value={value} />}
        </span>
        <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

export default function EnVivoTab() {
  const team = useLiveTeam();

  const totalHoy = team.operators.reduce((a, o) => a + o.total, 0);
  const trabajando = team.operators.filter(o => o.estado === 'trabajando').length;
  const sinMarcar = team.operators.filter(o => o.estado === 'presente_sin_marcar').length;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <motion.header {...fadeUp(0)} className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="hud-label text-accent">En vivo · Equipo</div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
            <span className="inline-flex w-10 h-10 rounded-2xl bg-accent/14 border border-accent/30 text-accent items-center justify-center shrink-0" aria-hidden="true">
              <Activity size={19} strokeWidth={2.25} />
            </span>
            Cómo va el equipo
          </h1>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <Radio size={12} className="text-success animate-pulse" aria-hidden="true" />
            En tiempo real · <span className="text-success font-semibold">{trabajando} trabajando</span>
            {sinMarcar > 0 && <> · <span className="text-warning font-semibold">{sinMarcar} sin marcar</span></>}
            {' '}· {totalHoy} gestiones hoy
          </p>
        </div>
      </motion.header>

      {team.status === 'error' && (
        <div className="rounded-2xl border border-danger/30 bg-danger/8 p-4 flex items-start gap-3 shadow-card3d">
          <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" aria-hidden="true" />
          <p className="text-sm text-danger">
            No se pudo leer la actividad del equipo. Esto NO significa que no trabajaron:
            significa que no se pudo consultar. Recargá; si sigue, avisá.
          </p>
        </div>
      )}

      {team.status === 'loading' && (
        <div className="rounded-2xl border border-border bg-card/40 p-10 flex items-center justify-center shadow-card3d">
          <Loader2 className="animate-spin text-accent" size={20} aria-hidden="true" />
        </div>
      )}

      {team.status === 'ok' && (
        <>
          {/* Backlog compartido de la tienda — lo que falta por trabajar. */}
          <motion.section {...fadeUp(0.05)} className="space-y-2">
            <div className="hud-label text-muted-foreground/70">Pendiente en la tienda</div>
            <div className="flex flex-wrap gap-3">
              <BacklogTile icon={Phone} label="Por confirmar" value={team.pendingConfirmar} />
              <BacklogTile icon={AlertTriangle} label="Novedades por gestionar" value={team.pendingNovedades} />
            </div>
          </motion.section>

          {/* Operadoras — trabajando primero. */}
          <motion.section {...fadeUp(0.1)} className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="hud-label text-muted-foreground/70">Por operadora · hoy</div>
              {!team.presenceMouseOk && (
                <span className="text-[11px] text-warning">
                  Presencia por actividad de mouse no disponible — se usa el trabajo marcado.
                </span>
              )}
            </div>
            {team.operators.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center">
                <CheckCircle2 size={22} className="text-muted-foreground mx-auto mb-2" aria-hidden="true" />
                <p className="text-sm font-semibold text-foreground">Todavía nadie registró trabajo hoy</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Apenas una operadora marque una gestión (Confirmar, Seguimiento o Novedades),
                  aparece acá al instante.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {team.operators.map((op) => (
                  <OperatorCard key={op.id} op={op} />
                ))}
              </div>
            )}
          </motion.section>
        </>
      )}
    </div>
  );
}
