import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Loader2, Clock } from 'lucide-react';
import { useWalletSyncHealth, type WalletSyncStatus } from '@/hooks/useWalletSyncHealth';
import { useStore } from '@/contexts/StoreContext';

// Badge visual de "última sincronización wallet" — verde/amarillo/rojo
// según el status que devuelva useWalletSyncHealth.
//
// Auto-refresca el texto relativo ("hace 2h") cada 60s sin re-fetch
// usando un tick local. La query se invalida cuando se completa un sync
// (ver useWalletSync.onSuccess).

interface Props {
  size?: 'sm' | 'md';
  showLabel?: boolean;  // true = "Sincronizado hace 2h", false = solo "hace 2h"
  className?: string;
}

const STATUS_CLS: Record<WalletSyncStatus, string> = {
  fresh:    'border-success/40 bg-success/10 text-success',
  stale:    'border-orange/40 bg-orange/10 text-orange',
  critical: 'border-danger/40 bg-danger/10 text-danger',
  never:    'border-border bg-muted/30 text-muted-foreground',
};

const STATUS_ICON: Record<WalletSyncStatus, React.ElementType> = {
  fresh:    CheckCircle2,
  stale:    AlertTriangle,
  critical: AlertCircle,
  never:    Clock,
};

function formatRelative(hours: number | null): string {
  if (hours === null) return 'Nunca sincronizado';
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `hace ${mins} min`;
  }
  if (hours < 24) {
    const h = Math.round(hours);
    return `hace ${h}h`;
  }
  const days = Math.round(hours / 24);
  return `hace ${days} día${days > 1 ? 's' : ''}`;
}

// Re-renderiza cada 60s para que "hace 2h" suba a "hace 3h" sin re-fetchear.
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

export default function WalletSyncBadge({ size = 'sm', showLabel = false, className = '' }: Props) {
  const { activeStoreId } = useStore();
  const q = useWalletSyncHealth(activeStoreId);
  useMinuteTick();

  if (q.isLoading) {
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] text-muted-foreground ${className}`}>
        <Loader2 size={10} className="animate-spin" />
        verificando…
      </span>
    );
  }

  if (q.isError || !q.data) return null;

  // Recalcular horas en cliente (puede haber pasado tiempo desde la query)
  const hours = q.data.lastSyncAt
    ? (Date.now() - q.data.lastSyncAt.getTime()) / 3_600_000
    : null;

  const status: WalletSyncStatus = hours === null
    ? 'never'
    : hours < 8
      ? 'fresh'
      : hours < 24
        ? 'stale'
        : 'critical';

  const Icon = STATUS_ICON[status];
  const text = formatRelative(hours);
  const padding = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border tabular-nums ${STATUS_CLS[status]} ${padding} ${className}`}
      title={q.data.lastSyncAt ? `Última corrida del sync: ${q.data.lastSyncAt.toLocaleString('es-CO')}` : 'Sin corridas de sync'}
    >
      <Icon size={size === 'md' ? 12 : 10} />
      <span>
        {showLabel && status !== 'never' ? 'Sincronizado ' : ''}
        {text}
      </span>
    </span>
  );
}
