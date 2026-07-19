import { motion } from 'framer-motion';
import { useNovedadesSeguimiento, SeguimientoRange } from '@/hooks/useNovedadesSeguimiento';
import { formatDuration, NOVEDAD_TIPO_LABEL } from '@/lib/novedadGestion';
import { Stat } from '@/components/novedades/Stat';
import { NovCard, MetricBar, RangePills, EmptyCard } from '@/components/novedades/NovedadesChrome';
import { fadeUp } from '@/components/novedades/chromeTokens';
import {
  RefreshCw, Clock, Inbox, CheckCircle2, Truck, PhoneOff,
  AlertTriangle, TrendingUp, PackageCheck, Users, ListChecks,
} from 'lucide-react';

const RANGES: { key: SeguimientoRange; label: string }[] = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
];

const C_WARNING = 'hsl(var(--warning))';
const C_ACCENT = 'hsl(var(--accent))';

function pct(n: number | null): string {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

export default function NovedadesSeguimiento() {
  const s = useNovedadesSeguimiento();
  const entregaRate = s.resueltasConOutcome > 0 ? s.entregadasDeResueltas / s.resueltasConOutcome : null;

  // Techo de cada ranking. Si es 0 no hay proporción que dibujar: MetricBar
  // recibe null y pinta la pista vacía en vez de una barra al 0%, que se leería
  // como "medimos y dio cero".
  const maxFrecuente = s.frecuentes[0]?.count ?? 0;
  const maxOperadora = s.porOperadora.reduce((m, op) => Math.max(m, op.total), 0);

  return (
    <div className="space-y-5">
      {/* Range selector + refresh */}
      <motion.div {...fadeUp(0)} className="flex items-center justify-between gap-2 flex-wrap">
        <RangePills
          items={RANGES}
          value={s.range}
          onChange={s.setRange}
          ariaLabel="Período del seguimiento"
        />
        <button
          type="button"
          onClick={s.refresh}
          disabled={s.loading}
          className="h-9 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground text-xs font-semibold flex items-center gap-1.5 hover:text-foreground hover:border-border-strong transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-50"
        >
          <RefreshCw size={12} className={s.loading ? 'animate-spin' : ''} aria-hidden="true" />
          Recargar
        </button>
      </motion.div>

      {/* Cobertura del día */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={<Inbox size={17} />} label="En cola ahora" value={s.pendientes}
          tone={s.pendientes > 0 ? 'warning' : 'default'} hint="novedades sin gestionar"
        />
        <Stat
          icon={<CheckCircle2 size={17} />} label="Gestionadas hoy" value={s.gestionadasHoy}
          tone={s.gestionadasHoy > 0 ? 'success' : 'default'}
          hint={s.pendientes > 0 && s.gestionadasHoy === 0 ? '⚠ nadie tocó novedades hoy' : undefined}
        />
        <Stat icon={<TrendingUp size={17} />} label="Nuevas hoy ≈" value={s.nuevasHoy} tone="info" hint="entraron / se movieron hoy" />
        <Stat
          icon={<Clock size={17} />} label="Resp. promedio"
          value={formatDuration(s.tiempoRespuestaPromMs)} tone="default" hint="desde que se movió en Dropi"
        />
      </motion.div>

      {/* Por operadora — el lever de accountability */}
      <motion.div {...fadeUp(0.1)}>
        <NovCard
          title="Por operadora"
          icon={Users}
          iconClass="text-muted-foreground"
          note={`(${RANGES.find((r) => r.key === s.range)?.label})`}
        >
          {s.porOperadora.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">Sin operadoras en esta tienda.</p>
          ) : (
            <ul className="space-y-0.5">
              {s.porOperadora.map((op) => {
                const sinTocarHoy = op.hoy === 0 && s.pendientes > 0 && op.isMember;
                return (
                  <MetricBar
                    key={op.operatorId}
                    label={op.name}
                    color={sinTocarHoy ? 'hsl(var(--danger))' : C_ACCENT}
                    pct={maxOperadora > 0 ? (op.total / maxOperadora) * 100 : null}
                    right={
                      <span className="inline-flex items-center gap-2.5">
                        {sinTocarHoy && (
                          <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20 font-bold whitespace-nowrap glow-danger">
                            <AlertTriangle size={9} aria-hidden="true" /> 0 hoy
                          </span>
                        )}
                        <span className="text-success font-semibold tabular-nums" title="Resueltas">{op.resuelta}✓</span>
                        <span className="text-danger font-semibold tabular-nums" title="Devoluciones">{op.devolucion}↩</span>
                        <span className="text-warning font-semibold tabular-nums" title="Sin respuesta">{op.sinRespuesta}☎</span>
                        <span className="w-10 text-right font-bold text-foreground tabular-nums" title="Total / hoy">
                          {op.total}
                          <span className="text-muted-foreground font-normal">/{op.hoy}</span>
                        </span>
                      </span>
                    }
                  />
                );
              })}
            </ul>
          )}
          <div className="mt-3 pt-2.5 border-t border-border text-[9px] text-muted-foreground flex gap-3">
            <span>✓ resueltas</span><span>↩ devoluciones</span><span>☎ sin respuesta</span><span className="ml-auto">total/hoy</span>
          </div>
        </NovCard>
      </motion.div>

      {/* Resultados */}
      <motion.div {...fadeUp(0.14)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={<CheckCircle2 size={17} />} label="Resueltas" value={s.resueltas} tone="success" />
        <Stat icon={<Truck size={17} />} label="Devoluciones" value={s.devoluciones} tone="danger" />
        <Stat
          icon={<PhoneOff size={17} />} label="Tasa devolución" value={pct(s.tasaDevolucion)}
          tone={s.tasaDevolucion != null && s.tasaDevolucion > 0.3 ? 'danger' : 'default'}
          hint="de las cerradas"
        />
        <Stat
          icon={<PackageCheck size={17} />} label="Resueltas entregadas" value={pct(entregaRate)}
          tone={entregaRate != null && entregaRate >= 0.5 ? 'success' : 'default'}
          hint={`${s.entregadasDeResueltas}/${s.resueltasConOutcome} ya entregadas`}
        />
      </motion.div>

      {/* Novedades más frecuentes */}
      <motion.div {...fadeUp(0.18)}>
        <NovCard title="Novedades más frecuentes" icon={AlertTriangle} iconClass="text-warning">
          {s.frecuentes.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">Sin novedades en el período.</p>
          ) : (
            <ul className="space-y-0.5">
              {s.frecuentes.map((f, i) => (
                <MetricBar
                  key={f.label}
                  rank={i + 1}
                  label={f.label}
                  color={C_WARNING}
                  pct={maxFrecuente > 0 ? (f.count / maxFrecuente) * 100 : null}
                  right={f.count}
                />
              ))}
            </ul>
          )}
        </NovCard>
      </motion.div>

      {/* Detalle reciente de gestiones */}
      {s.gestiones.length > 0 && (
        <motion.div {...fadeUp(0.22)}>
          <NovCard
            title="Gestiones recientes"
            icon={ListChecks}
            note={`(${s.gestiones.length})`}
          >
            <div className="divide-y divide-border max-h-80 overflow-y-auto -mx-1">
              {s.gestiones.slice(0, 50).map((g, i) => {
                const tone =
                  g.tipo === 'resuelta' ? 'text-success' : g.tipo === 'devolucion' ? 'text-danger' : 'text-warning';
                return (
                  <div
                    key={`${g.phone}-${g.markedAt}-${i}`}
                    className="px-3 py-2 text-xs flex items-center gap-2 rounded-lg transition-colors duration-200 hover:bg-card/60"
                  >
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
                      <span className="text-muted-foreground/70 whitespace-nowrap font-mono tabular-nums" title="Tiempo de respuesta">
                        {formatDuration(g.responseMs)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </NovCard>
        </motion.div>
      )}

      {/* Sin nada que mostrar todavía: el mismo chip de estado del resto del área. */}
      {!s.loading && s.porOperadora.length === 0 && s.frecuentes.length === 0 && s.gestiones.length === 0 && (
        <motion.div {...fadeUp(0.26)}>
          <EmptyCard msg="Sin novedades en el período." />
        </motion.div>
      )}
    </div>
  );
}
