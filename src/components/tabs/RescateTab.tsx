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
        {/* Page header — patrón pro coherente con Logística */}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
              CRM · Operadora
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none flex items-center gap-2.5">
              <LifeBuoy size={22} className="text-danger" aria-hidden="true" strokeWidth={2.25} />
              Rescate
            </h1>
            <p className="text-sm text-muted-foreground">
              Pedidos en riesgo (D5+, novedades, oficina, devoluciones) que necesitan acción inmediata.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {resData.length > 0 && (
              <div className="hidden sm:flex flex-col gap-0.5 rounded-lg border border-danger/25 bg-danger/5 px-3 py-1.5">
                <span className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">Valor en riesgo</span>
                <span className="font-mono text-sm font-bold text-danger tabular-nums leading-none">
                  {formatCOP(stats.valorEnRiesgo)}
                </span>
              </div>
            )}
            <button
              onClick={() => loadResData(true)}
              disabled={resLoading}
              className="inline-flex h-9 items-center gap-1.5 px-3 rounded-lg border border-border bg-card text-xs font-semibold transition-colors hover:border-border-strong hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="Refrescar datos"
            >
              <RefreshCw size={13} className={resLoading ? 'animate-spin' : ''} aria-hidden="true" />
              <span className="hidden sm:inline">{resLoading ? 'Actualizando…' : 'Actualizar'}</span>
            </button>
          </div>
        </header>

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
