import { ReactNode } from 'react';
import { useNovedadesSeguimiento, SeguimientoRange } from '@/hooks/useNovedadesSeguimiento';
import { formatDuration, NOVEDAD_TIPO_LABEL } from '@/lib/novedadGestion';
import {
  RefreshCw, Clock, Inbox, CheckCircle2, Truck, PhoneOff,
  AlertTriangle, TrendingUp, PackageCheck, Users,
} from 'lucide-react';

const RANGES: { key: SeguimientoRange; label: string }[] = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
];

function pct(n: number | null): string {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

function Stat({
  icon, label, value, hint, tone = 'default',
}: {
  icon: ReactNode; label: string; value: string | number; hint?: string;
  tone?: 'default' | 'danger' | 'success' | 'warning' | 'info';
}) {
  const bar = {
    default: 'bg-muted-foreground/40', danger: 'bg-danger', success: 'bg-success',
    warning: 'bg-warning', info: 'bg-info',
  }[tone];
  const valColor = {
    default: 'text-foreground', danger: 'text-danger', success: 'text-success',
    warning: 'text-warning', info: 'text-info',
  }[tone];
  return (
    <div className="relative overflow-hidden bg-card rounded-xl border border-border p-4 shadow-ds-xs">
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${bar}`} aria-hidden="true" />
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        {icon} {label}
      </div>
      <div className={`font-mono text-2xl font-bold tabular-nums ${valColor}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

export default function NovedadesSeguimiento() {
  const s = useNovedadesSeguimiento();
  const entregaRate = s.resueltasConOutcome > 0 ? s.entregadasDeResueltas / s.resueltasConOutcome : null;

  return (
    <div className="space-y-5">
      {/* Range selector + refresh */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => s.setRange(r.key)}
              className={`px-3 h-8 rounded-md text-xs font-semibold transition-colors ${
                s.range === r.key
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          onClick={s.refresh}
          disabled={s.loading}
          className="h-8 px-3 rounded-lg border border-border bg-surface text-muted-foreground text-xs font-semibold flex items-center gap-1.5 hover:text-foreground hover:border-accent/30 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={s.loading ? 'animate-spin' : ''} />
          Recargar
        </button>
      </div>

      {/* Cobertura del día */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={<Inbox size={11} />} label="En cola ahora" value={s.pendientes}
          tone={s.pendientes > 0 ? 'warning' : 'default'} hint="novedades sin gestionar"
        />
        <Stat
          icon={<CheckCircle2 size={11} />} label="Gestionadas hoy" value={s.gestionadasHoy}
          tone={s.gestionadasHoy > 0 ? 'success' : 'default'}
          hint={s.pendientes > 0 && s.gestionadasHoy === 0 ? '⚠ nadie tocó novedades hoy' : undefined}
        />
        <Stat icon={<TrendingUp size={11} />} label="Nuevas hoy ≈" value={s.nuevasHoy} tone="info" hint="entraron / se movieron hoy" />
        <Stat
          icon={<Clock size={11} />} label="Resp. promedio"
          value={formatDuration(s.tiempoRespuestaPromMs)} tone="default" hint="desde que se movió en Dropi"
        />
      </div>

      {/* Por operadora — el lever de accountability */}
      <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
          <Users size={13} className="text-muted-foreground" />
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">Por operadora</h3>
          <span className="text-[10px] text-muted-foreground">({RANGES.find((r) => r.key === s.range)?.label})</span>
        </div>
        {s.porOperadora.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">Sin operadoras en esta tienda.</div>
        ) : (
          <div className="divide-y divide-border">
            {s.porOperadora.map((op) => {
              const sinTocarHoy = op.hoy === 0 && s.pendientes > 0 && op.isMember;
              return (
                <div key={op.operatorId} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="font-semibold text-foreground truncate">{op.name}</span>
                    {sinTocarHoy && (
                      <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20 font-bold whitespace-nowrap">
                        <AlertTriangle size={9} /> 0 hoy
                      </span>
                    )}
                  </div>
                  <span className="text-success font-semibold tabular-nums" title="Resueltas">{op.resuelta}✓</span>
                  <span className="text-danger font-semibold tabular-nums" title="Devoluciones">{op.devolucion}↩</span>
                  <span className="text-warning font-semibold tabular-nums" title="Sin respuesta">{op.sinRespuesta}☎</span>
                  <span className="w-10 text-right font-mono font-bold text-foreground tabular-nums" title="Total / hoy">
                    {op.total}
                    <span className="text-muted-foreground font-normal">/{op.hoy}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="px-4 py-1.5 border-t border-border text-[9px] text-muted-foreground flex gap-3">
          <span>✓ resueltas</span><span>↩ devoluciones</span><span>☎ sin respuesta</span><span className="ml-auto">total/hoy</span>
        </div>
      </section>

      {/* Resultados */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={<CheckCircle2 size={11} />} label="Resueltas" value={s.resueltas} tone="success" />
        <Stat icon={<Truck size={11} />} label="Devoluciones" value={s.devoluciones} tone="danger" />
        <Stat
          icon={<PhoneOff size={11} />} label="Tasa devolución" value={pct(s.tasaDevolucion)}
          tone={s.tasaDevolucion != null && s.tasaDevolucion > 0.3 ? 'danger' : 'default'}
          hint="de las cerradas"
        />
        <Stat
          icon={<PackageCheck size={11} />} label="Resueltas entregadas" value={pct(entregaRate)}
          tone={entregaRate != null && entregaRate >= 0.5 ? 'success' : 'default'}
          hint={`${s.entregadasDeResueltas}/${s.resueltasConOutcome} ya entregadas`}
        />
      </div>

      {/* Novedades más frecuentes */}
      <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
          <AlertTriangle size={13} className="text-warning" />
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">Novedades más frecuentes</h3>
        </div>
        {s.frecuentes.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">Sin novedades en el período.</div>
        ) : (
          <div className="p-3 space-y-1.5">
            {s.frecuentes.map((f) => {
              const max = s.frecuentes[0].count || 1;
              return (
                <div key={f.label} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center mb-0.5">
                      <span className="text-xs text-foreground truncate pr-2">{f.label}</span>
                      <span className="text-xs font-mono font-bold text-muted-foreground tabular-nums">{f.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-warning/60 rounded-full" style={{ width: `${(f.count / max) * 100}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Detalle reciente de gestiones */}
      {s.gestiones.length > 0 && (
        <section className="bg-card rounded-xl border border-border shadow-ds-xs overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border">
            <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">
              Gestiones recientes <span className="text-muted-foreground font-normal">({s.gestiones.length})</span>
            </h3>
          </div>
          <div className="divide-y divide-border max-h-80 overflow-y-auto">
            {s.gestiones.slice(0, 50).map((g, i) => {
              const tone =
                g.tipo === 'resuelta' ? 'text-success' : g.tipo === 'devolucion' ? 'text-danger' : 'text-warning';
              return (
                <div key={`${g.phone}-${g.markedAt}-${i}`} className="px-4 py-2 text-xs flex items-center gap-2">
                  <span className={`font-semibold whitespace-nowrap ${tone}`}>{NOVEDAD_TIPO_LABEL[g.tipo]}</span>
                  <span className="text-foreground truncate flex-1 min-w-0">
                    {g.nombre || g.phone}
                    {g.outcome === 'entregada' && (
                      <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20 font-bold">entregada</span>
                    )}
                    {g.outcome === 'devuelta' && (
                      <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20 font-bold">devuelta</span>
                    )}
                  </span>
                  <span className="text-muted-foreground whitespace-nowrap">{g.operatorName}</span>
                  {g.responseMs != null && (
                    <span className="text-muted-foreground/70 whitespace-nowrap tabular-nums" title="Tiempo de respuesta">
                      {formatDuration(g.responseMs)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
