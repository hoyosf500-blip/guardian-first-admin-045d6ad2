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

const LEVEL_STYLES: Record<AlertLevel, { bg: string; border: string; text: string; iconClass: string }> = {
  ok:       { bg: 'bg-green-500/10',   border: 'border-green-500/30',   text: 'text-green-600 dark:text-green-400',     iconClass: 'text-green-500' },
  watch:    { bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30',  text: 'text-yellow-600 dark:text-yellow-400',   iconClass: 'text-yellow-500' },
  alert:    { bg: 'bg-orange-500/10',  border: 'border-orange-500/30',  text: 'text-orange-600 dark:text-orange-400',   iconClass: 'text-orange-500' },
  critical: { bg: 'bg-red-500/10',     border: 'border-red-500/30',     text: 'text-red-600 dark:text-red-400',         iconClass: 'text-red-500' },
  lost:     { bg: 'bg-gray-500/10',    border: 'border-gray-500/30',    text: 'text-gray-600 dark:text-gray-400',       iconClass: 'text-gray-500' },
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
    pct < 50 ? 'bg-green-500'
    : pct < 75 ? 'bg-yellow-500'
    : pct < 100 ? 'bg-orange-500'
    : 'bg-red-500';

  return (
    <motion.div
      role="alert"
      aria-live="assertive"
      aria-label={`Alerta SLA: ${alert.label}`}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`rounded-2xl border ${style.border} ${style.bg} p-4 md:p-5`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <LevelIcon level={alert.level} className={style.iconClass} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg">{alert.icon}</span>
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
              <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                <span>0d</span>
                <span>{carrierDeadline}d (deadline {order.transportadora || '?'})</span>
              </div>
              <div
                className="w-full h-1.5 rounded-full bg-muted/60 overflow-hidden"
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
            <div className="mt-3 p-2 rounded-lg bg-card/50 border border-border text-xs">
              <strong>Plazo de oficina:</strong> {alert.officeCD.remaining > 0
                ? `Quedan ${alert.officeCD.remaining} día${alert.officeCD.remaining === 1 ? '' : 's'} para que el cliente reclame en ${alert.officeCD.carrier}`
                : `Plazo vencido — el paquete puede volver al remitente`}
            </div>
          )}

          {/* Countdown for novedad rescue */}
          {alert.novedadW && (
            <div className="mt-3 p-2 rounded-lg bg-card/50 border border-border text-xs">
              <strong>Rescate de novedad:</strong> {alert.novedadW.remaining > 0
                ? `Quedan ${alert.novedadW.remaining} día${alert.novedadW.remaining === 1 ? '' : 's'} de la ventana de 3 días para rescatar`
                : `Ventana de rescate vencida — devolución probable`}
            </div>
          )}

          {/* Suggested action banner */}
          {suggested && (
            <div className="mt-3 p-3 rounded-lg bg-card border border-border flex items-start gap-2">
              <AlertTriangle size={14} className="text-orange-500 flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-0.5">
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
