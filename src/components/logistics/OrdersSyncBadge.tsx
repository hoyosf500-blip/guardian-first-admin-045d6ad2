import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Loader2 } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useOrdersSyncHealth, type OrdersSyncStatus } from '@/hooks/useOrdersSyncHealth';

// Badge de frescura del sync de ÓRDENES (pedidos) para el header de "Cómo voy".
// Reemplaza al WalletSyncBadge que estaba ahí dando frescura falsa (medía wallet
// al lado de "pedidos generados"). El prefijo "Pedidos:" desambigua. La frescura
// de wallet sigue señalada en su propia card (walletStale).
//
// Mismo look/umbral visual que WalletSyncBadge (verde/amarillo/rojo), pero
// autocontenido: WalletSyncBadge se usa en otras 3 pantallas y NO se toca.

interface Props {
  size?: 'sm' | 'md';
  className?: string;
}

// Map status → presentación. 'hidden' nunca llega acá (se filtra antes).
const TONE_CLS: Record<Exclude<OrdersSyncStatus, 'hidden'>, string> = {
  fresh: 'border-success/40 bg-success/10 text-success',
  stale: 'border-orange/40 bg-orange/10 text-orange',
  error: 'border-danger/40 bg-danger/10 text-danger',
};

const TONE_ICON: Record<Exclude<OrdersSyncStatus, 'hidden'>, React.ElementType> = {
  fresh: CheckCircle2,
  stale: AlertTriangle,
  error: AlertCircle,
};

function formatRelative(hours: number | null): string {
  if (hours === null) return 'sin sync';
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `hace ${mins} min`;
  }
  if (hours < 24) return `hace ${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `hace ${days} día${days > 1 ? 's' : ''}`;
}

// Re-render cada 60s para que el relativo avance sin re-fetch (patrón WalletSyncBadge).
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

export default function OrdersSyncBadge({ size = 'sm', className = '' }: Props) {
  const { activeStoreId } = useStore();
  const q = useOrdersSyncHealth(activeStoreId);
  useMinuteTick();

  if (q.isLoading) {
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] text-muted-foreground ${className}`}>
        <Loader2 size={10} className="animate-spin" />
        verificando…
      </span>
    );
  }

  // Sin datos / sin permiso RLS / error de query → ocultar (no mostrar "sin sync" falso).
  if (q.isError || !q.data || q.data.status === 'hidden') return null;

  const { status, lastSuccessAt, lastAttemptAt, lastErrorMessage } = q.data;
  const tone = status as Exclude<OrdersSyncStatus, 'hidden'>;
  const Icon = TONE_ICON[tone];

  const hours = lastSuccessAt ? (Date.now() - lastSuccessAt.getTime()) / 3_600_000 : null;
  const text = `Pedidos: ${formatRelative(hours)}`;
  const padding = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]';

  const title = lastErrorMessage
    ? `Pedidos — ${lastErrorMessage}`
    : lastAttemptAt
      ? `Último sync de pedidos: ${(lastSuccessAt ?? lastAttemptAt).toLocaleString('es-CO')}`
      : undefined;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border tabular-nums ${TONE_CLS[tone]} ${padding} ${className}`}
      title={title}
    >
      <Icon size={size === 'md' ? 12 : 10} />
      <span>{text}</span>
    </span>
  );
}
