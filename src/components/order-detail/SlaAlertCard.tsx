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

const LEVEL_STYLES: Record<AlertLevel, { bg: string; border: string; borderL: string; text: string; iconClass: string }> = {
  ok:       { bg: 'bg-card/40', border: 'border-border', borderL: 'bg-success', text: 'text-success', iconClass: 'text-success' },
  watch:    { bg: 'bg-warning/10', border: 'border-warning/25', borderL: 'bg-warning', text: 'text-warning', iconClass: 'text-warning' },
  alert:    { bg: 'bg-warning/10', border: 'border-warning/25', borderL: 'bg-warning', text: 'text-warning', iconClass: 'text-warning' },
  critical: { bg: 'bg-danger/10',  border: 'border-danger/25',  borderL: 'bg-danger',  text: 'text-danger',  iconClass: 'text-danger' },
  lost:     { bg: 'bg-card/40', border: 'border-border', borderL: 'bg-muted-foreground', text: 'text-muted-foreground', iconClass: 'text-muted-foreground' },
};

function LevelIcon({ level, className }: { level: AlertLevel; className?: string }) {
  if (level === 'ok') return <CheckCircle2 size={20} className={className} />;
  if (level === 'watch') return <Radio size={20} className={className} />;
  if (level === 'alert' || level === 'critical') return <AlertTriangle size={20} className={className} />;
  return <Clock size={20} className={className} />;
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

  const progressColor =
    pct < 50 ? 'bg-success'
    : pct < 75 ? 'bg-warning'
    : pct < 100 ? 'bg-warning'
    : 'bg-danger';

  return (
    <motion.div
      role="alert"
      aria-live="assertive"
      aria-label={`Alerta SLA: ${alert.label}`}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`relative rounded-2xl border ${style.border} ${style.bg} p-4 pl-5 md:p-5 md:pl-6 shadow-card3d`}
    >
      <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${style.borderL}`} aria-hidden="true" />
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
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

          {/* Progress bar days elapsed vs carrier deadline */}
          {carrierDeadline > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-1 font-mono tabular-nums">
                <span>0d</span>
                <span>{carrierDeadline}d (deadline {order.transportadora || '?'})</span>
              </div>
              <div
                className="w-full h-1.5 rounded-full bg-foreground/10 overflow-hidden"
                role="progressbar"
                aria-valuenow={daysElapsed}
                aria-valuemin={0}
                aria-valuemax={carrierDeadline}
                aria-label={`${daysElapsed} de ${carrierDeadline} días transcurridos`}
              >
                <div
                  className={`h-full rounded-full transition-all ${progressColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {/* Countdown for office pickup */}
          {alert.officeCD && (
            <div className="mt-3 p-2.5 rounded-2xl bg-card/40 border border-border shadow-card3d hairline-top hover:border-border-strong transition-colors text-xs">
              <strong>Plazo de oficina:</strong> {alert.officeCD.remaining > 0
                ? `Quedan ${alert.officeCD.remaining} día${alert.officeCD.remaining === 1 ? '' : 's'} para que el cliente reclame en ${alert.officeCD.carrier}`
                : `Plazo vencido — el paquete puede volver al remitente`}
            </div>
          )}

          {/* Countdown for novedad rescue */}
          {alert.novedadW && (
            <div className="mt-3 p-2.5 rounded-2xl bg-card/40 border border-border shadow-card3d hairline-top hover:border-border-strong transition-colors text-xs">
              <strong>Rescate de novedad:</strong> {alert.novedadW.remaining > 0
                ? `Quedan ${alert.novedadW.remaining} día${alert.novedadW.remaining === 1 ? '' : 's'} de la ventana de 3 días para rescatar`
                : `Ventana de rescate vencida — devolución probable`}
            </div>
          )}

          {/* Suggested action banner */}
          {suggested && (
            <div className="relative mt-3 p-3 pl-4 rounded-2xl bg-card/40 border border-border shadow-card3d flex items-start gap-2">
              <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
              <AlertTriangle size={14} className="text-warning flex-shrink-0 mt-0.5" aria-hidden="true" />
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
