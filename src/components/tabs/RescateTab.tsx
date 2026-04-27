import { useEffect, useMemo } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { RES_ACTIONS } from '@/lib/constants';
import { formatCOP } from '@/lib/utils';
import { LifeBuoy, RefreshCw, AlertTriangle, MapPin, RotateCcw, ShieldAlert } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';
import SegRescueCounterBar from '@/components/SegRescueCounterBar';

/** Tono semántico → clases tokenizadas. Sin hex inline. */
const TONE = {
  danger:  { bg: 'bg-danger/10',  border: 'border-danger/25',  text: 'text-danger',  stripe: 'bg-danger' },
  warning: { bg: 'bg-warning/10', border: 'border-warning/25', text: 'text-warning', stripe: 'bg-warning' },
  info:    { bg: 'bg-info/10',    border: 'border-info/25',    text: 'text-info',    stripe: 'bg-info' },
  ai:      { bg: 'bg-ai/10',      border: 'border-ai/25',      text: 'text-ai',      stripe: 'bg-ai' },
} as const;

type Tone = keyof typeof TONE;

export default function RescateTab() {
  const { resData, resLoaded, resLoading, loadResData } = useOrders();

  useEffect(() => { loadResData(); }, [loadResData]);

  const stats = useMemo(() => {
    let novedades = 0, oficina = 0, devoluciones = 0, retrasados = 0;
    let valorEnRiesgo = 0;
    resData.forEach(o => {
      const e = o.estado.toUpperCase();
      if (e.includes('NOVEDAD') || e === 'INTENTO DE ENTREGA') novedades++;
      else if (e.includes('OFICINA') || e.includes('RECLAME')) oficina++;
      else if (e.includes('DEVOL')) devoluciones++;
      else retrasados++;
      valorEnRiesgo += o.valor;
    });
    return { novedades, oficina, devoluciones, retrasados, valorEnRiesgo };
  }, [resData]);

  if (!resLoaded && resLoading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <RefreshCw size={32} className="text-accent animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando rescate...</p>
            <p className="text-xs text-muted-foreground mt-1">Buscando pedidos en riesgo</p>
          </div>
        </div>
      </div>
    );
  }

  const statCards: Array<{ label: string; value: number; icon: JSX.Element; tone: Tone }> = [
    { label: 'Novedades',      value: stats.novedades,    icon: <AlertTriangle size={16} />, tone: 'danger' },
    { label: 'En Oficina',     value: stats.oficina,      icon: <MapPin size={16} />,        tone: 'ai' },
    { label: 'Devoluciones',   value: stats.devoluciones, icon: <RotateCcw size={16} />,     tone: 'danger' },
    { label: 'Retrasados 5d+', value: stats.retrasados,   icon: <ShieldAlert size={16} />,   tone: 'warning' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      <SegRescueCounterBar module="RESCUE" />
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6 space-y-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-danger to-danger/70 text-danger-foreground shadow-ds-md"
              aria-hidden="true"
            >
              <LifeBuoy size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground tracking-tight">Rescate</h2>
              <p className="text-xs text-muted-foreground">Pedidos en riesgo que necesitan acción inmediata</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {resData.length > 0 && (
              <div className="hidden sm:flex items-center gap-2 rounded-xl border border-danger/20 bg-danger/5 px-4 py-2">
                <span className="text-xs text-muted-foreground">Valor en riesgo</span>
                <span className="text-sm font-bold text-danger tabular-nums">
                  {formatCOP(stats.valorEnRiesgo)}
                </span>
              </div>
            )}
            <button
              onClick={() => loadResData(true)}
              disabled={resLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border bg-surface text-muted-foreground text-xs font-semibold hover:text-foreground hover:border-accent/30 hover:bg-accent/5 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw size={13} className={resLoading ? 'animate-spin' : ''} /> Actualizar
            </button>
          </div>
        </div>

        {/* Stats row */}
        {resData.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {statCards.map((s, i) => {
              const t = TONE[s.tone];
              return (
                <motion.div
                  key={s.label}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.22 }}
                  className={`relative overflow-hidden rounded-xl border ${t.border} ${t.bg} px-4 py-3 flex items-center gap-3 shadow-ds-xs`}
                >
                  <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${t.stripe}`} aria-hidden="true" />
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${t.bg} ${t.text} border ${t.border}`}>
                    {s.icon}
                  </div>
                  <div>
                    <p className={`text-lg font-bold tabular-nums ${t.text}`}>{s.value}</p>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground leading-tight">{s.label}</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </motion.div>

      <CrmTable
        data={resData}
        actions={RES_ACTIONS}
        module="RESCUE"
        emptyIcon={<LifeBuoy size={28} className="text-muted-foreground" />}
        emptyTitle="Sin pedidos en rescate"
        emptyDesc="Los pedidos en riesgo (D5+, novedades, oficina) aparecerán aquí."
      />
    </div>
  );
}
