import { motion } from 'framer-motion';
import { AlertTriangle, Clock, CheckCircle2, Radio } from 'lucide-react';
import { OrderData } from '@/lib/orderUtils';
import {
  getAlertLevel,
  needsAction,
  getSuggestedAction,
  getCarrierDeadline,
  AlertLevel,
} from '@/lib/alertSystem';

interface Props {
  order: OrderData;
}

/**
 * Estilos por nivel. `chip`/`glow` son la fórmula de tinte del DS para el chip
 * de ícono del banner; `borderL` es la barra lateral de color pleno.
 */
const LEVEL_STYLES: Record<AlertLevel, { bg: string; border: string; borderL: string; text: string; iconClass: string; chip: string; glow: string }> = {
  ok:       { bg: 'bg-card/40', border: 'border-border', borderL: 'bg-success', text: 'text-success', iconClass: 'text-success', chip: 'bg-success/14 border-success/30', glow: 'glow-success' },
  watch:    { bg: 'bg-warning/10', border: 'border-warning/25', borderL: 'bg-warning', text: 'text-warning', iconClass: 'text-warning', chip: 'bg-warning/14 border-warning/30', glow: 'glow-warning' },
  alert:    { bg: 'bg-warning/10', border: 'border-warning/25', borderL: 'bg-warning', text: 'text-warning', iconClass: 'text-warning', chip: 'bg-warning/14 border-warning/30', glow: 'glow-warning' },
  critical: { bg: 'bg-danger/10',  border: 'border-danger/25',  borderL: 'bg-danger',  text: 'text-danger',  iconClass: 'text-danger',  chip: 'bg-danger/14 border-danger/30',   glow: 'glow-danger' },
  lost:     { bg: 'bg-card/40', border: 'border-border', borderL: 'bg-muted-foreground', text: 'text-muted-foreground', iconClass: 'text-muted-foreground', chip: 'bg-muted/60 border-border', glow: '' },
};

/** `hsl(var(--x))` → `hsl(var(--x) / a)` para halos y degradados. */
const ring = (color: string, alpha: number) => color.replace(/\)$/, ` / ${alpha})`);

function LevelIcon({ level, className }: { level: AlertLevel; className?: string }) {
  if (level === 'ok') return <CheckCircle2 size={20} className={className} />;
  if (level === 'watch') return <Radio size={20} className={className} />;
  if (level === 'alert' || level === 'critical') return <AlertTriangle size={20} className={className} />;
  return <Clock size={20} className={className} />;
}

/**
 * Aviso interno del banner (plazo de oficina / rescate de novedad). Mismo molde
 * que el banner grande: barra lateral de color + superficie translúcida.
 */
function CountdownNote({ tone, children }: { tone: 'info' | 'warning'; children: React.ReactNode }) {
  const bar = tone === 'info' ? 'bg-info' : 'bg-warning';
  const surface = tone === 'info' ? 'border-info/30 bg-info/10' : 'border-warning/30 bg-warning/10';
  return (
    <div className={`relative mt-3 p-2.5 pl-4 rounded-2xl border ${surface} shadow-card3d hairline-top text-xs`}>
      <span className={`absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full ${bar}`} aria-hidden="true" />
      {children}
    </div>
  );
}

export default function SlaAlertCard({ order }: Props) {
  const alert = getAlertLevel(
    order.diasConf,
    order.dias,
    order.estado,
    order.transportadora,
    order.novedad,
  );

  // No alert to show — fresh order, no delay, or fully delivered
  if (!alert) return null;

  const style = LEVEL_STYLES[alert.level];
  const carrierDeadline = getCarrierDeadline(order.transportadora);
  const daysElapsed = alert.sinEscaneo;
  const pct = Math.min(100, Math.round((daysElapsed / carrierDeadline) * 100));

  const shouldAct = needsAction(order.estado, order.diasConf, order.dias, order.novedadSol, null);
  const suggested = shouldAct
    ? getSuggestedAction(order.estado, order.novedad, order.transportadora, order.diasConf)
    : null;

  // Mismos umbrales de siempre (50 / 75 / 100), pero resueltos a token crudo:
  // el relleno pasó de un color plano a un degradado con glow y no se puede
  // pintar con una clase.
  const progressStroke =
    pct < 50 ? 'hsl(var(--success))'
    : pct < 75 ? 'hsl(var(--warning))'
    : pct < 100 ? 'hsl(var(--warning))'
    : 'hsl(var(--danger))';

  return (
    <motion.div
      role="alert"
      aria-live="assertive"
      aria-label={`Alerta SLA: ${alert.label}`}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`relative rounded-2xl border ${style.border} ${style.bg} p-4 pl-5 md:p-5 md:pl-6 shadow-card3d hairline-top`}
    >
      <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${style.borderL}`} aria-hidden="true" />
      <div className="flex items-start gap-3">
        <div className={`w-11 h-11 rounded-2xl border flex items-center justify-center flex-shrink-0 ${style.chip} ${style.glow} ${style.iconClass}`}>
          <LevelIcon level={alert.level} className={style.iconClass} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-sm font-bold ${style.text}`}>{alert.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {daysElapsed > 0
              ? `Sin escaneo de transportadora hace ${daysElapsed} día${daysElapsed === 1 ? '' : 's'}`
              : 'Escaneo reciente de transportadora'}
            {order.transportadora ? ` · ${order.transportadora} (deadline ${carrierDeadline}d)` : ''}
          </p>

          {/* Consumo del plazo de la transportadora: pista tenue, relleno con
              degradado + glow, marcas fijas al 50/75% y cabeza luminosa en la
              posición actual (mismo remate que el punto final del área del
              Dashboard). Antes era una barrita de color plano. */}
          {carrierDeadline > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-1.5 font-mono tabular-nums">
                <span>0d</span>
                <span>{carrierDeadline}d (deadline {order.transportadora || '?'})</span>
              </div>
              <div className="relative">
                <div
                  className="relative w-full h-2.5 rounded-full bg-foreground/10 overflow-hidden"
                  role="progressbar"
                  aria-valuenow={daysElapsed}
                  aria-valuemin={0}
                  aria-valuemax={carrierDeadline}
                  aria-label={`${daysElapsed} de ${carrierDeadline} días transcurridos`}
                >
                  <span aria-hidden="true" className="absolute inset-y-0 w-px bg-background/70" style={{ left: '50%' }} />
                  <span aria-hidden="true" className="absolute inset-y-0 w-px bg-background/70" style={{ left: '75%' }} />
                  <div
                    className="h-full rounded-full transition-[width] duration-700"
                    style={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, ${ring(progressStroke, 0.55)}, ${progressStroke})`,
                      boxShadow: `0 0 12px ${ring(progressStroke, 0.65)}`,
                    }}
                  />
                </div>
                {pct > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 w-2.5 h-2.5 rounded-full -translate-y-1/2 -translate-x-1/2"
                    style={{
                      left: `${pct}%`,
                      background: 'hsl(var(--background))',
                      border: `2px solid ${progressStroke}`,
                      boxShadow: `0 0 10px ${ring(progressStroke, 0.9)}`,
                    }}
                  />
                )}
              </div>
            </div>
          )}

          {/* Countdown for office pickup */}
          {alert.officeCD && (
            <CountdownNote tone="info">
              <strong>Plazo de oficina:</strong> {alert.officeCD.remaining > 0
                ? `Quedan ${alert.officeCD.remaining} día${alert.officeCD.remaining === 1 ? '' : 's'} para que el cliente reclame en ${alert.officeCD.carrier}`
                : `Plazo vencido — el paquete puede volver al remitente`}
            </CountdownNote>
          )}

          {/* Countdown for novedad rescue */}
          {alert.novedadW && (
            <CountdownNote tone="warning">
              <strong>Rescate de novedad:</strong> {alert.novedadW.remaining > 0
                ? `Quedan ${alert.novedadW.remaining} día${alert.novedadW.remaining === 1 ? '' : 's'} de la ventana de 3 días para rescatar`
                : `Ventana de rescate vencida — devolución probable`}
            </CountdownNote>
          )}

          {/* Suggested action banner */}
          {suggested && (
            <div className="relative mt-3 p-3 pl-4 rounded-2xl border border-warning/30 bg-warning/10 shadow-card3d hairline-top flex items-start gap-2.5">
              <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
              <span className="w-9 h-9 rounded-xl bg-warning/20 glow-warning flex items-center justify-center flex-shrink-0 text-warning">
                <AlertTriangle size={17} aria-hidden="true" />
              </span>
              <div>
                <div className="hud-label mb-0.5">
                  Acción sugerida
                </div>
                <div className="text-xs text-foreground">{suggested}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
