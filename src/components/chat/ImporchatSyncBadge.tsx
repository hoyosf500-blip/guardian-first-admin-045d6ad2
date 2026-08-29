import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Loader2, Clock, KeyRound } from 'lucide-react';
import { useImporchatSyncHealth, type ImporchatSyncStatus } from '@/hooks/useImporchatSyncHealth';
import { useStore } from '@/contexts/StoreContext';

// Badge de salud de ImporChat (lo que el cliente nos escribe). Verde/amarillo/rojo
// según corrió-y-guardó, MÁS un aviso propio de la llave de 7 días: si vence y no
// se renueva, el inbound se apaga aunque el cron "corra". Sin esto la caída era
// silenciosa (el dueño se enteraba por los clientes sin contestar).

interface Props {
  size?: 'sm' | 'md';
  className?: string;
}

const STATUS_CLS: Record<ImporchatSyncStatus, string> = {
  fresh:    'border-success/40 bg-success/10 text-success',
  stale:    'border-orange/40 bg-orange/10 text-orange',
  critical: 'border-danger/40 bg-danger/10 text-danger',
  failing:  'border-danger/40 bg-danger/10 text-danger',
  never:    'border-border bg-muted/30 text-muted-foreground',
};

const STATUS_ICON: Record<ImporchatSyncStatus, React.ElementType> = {
  fresh: CheckCircle2, stale: AlertTriangle, critical: AlertCircle, failing: AlertCircle, never: Clock,
};

function formatRelative(hours: number | null): string {
  if (hours === null) return 'Nunca';
  if (hours < 1) return `hace ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `hace ${Math.round(hours)}h`;
  const d = Math.round(hours / 24);
  return `hace ${d} día${d > 1 ? 's' : ''}`;
}

function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

export default function ImporchatSyncBadge({ size = 'sm', className = '' }: Props) {
  const { activeStoreId } = useStore();
  const q = useImporchatSyncHealth(activeStoreId);
  useMinuteTick();

  if (q.isLoading) {
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] text-muted-foreground ${className}`}>
        <Loader2 size={10} className="animate-spin" /> verificando…
      </span>
    );
  }
  // isError o sin datos = tienda sin ImporChat (o sin permiso): no se dibuja nada.
  if (q.isError || !q.data) return null;

  const padding = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]';
  const restante = q.data.tokenHorasRestantes;

  // La LLAVE manda sobre la frescura: una llave vencida/por vencer apaga TODO el
  // inbound, así que es lo primero que hay que gritar. El margen de auto-renovación
  // es 48h; si baja de 24h y sigue ahí, la renovación no está funcionando.
  if (restante != null && restante <= 0) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 text-danger ${padding} ${className}`}
        title="La llave de ImporChat venció y no se renovó. El WhatsApp del cliente NO está entrando. Hay que renovarla.">
        <KeyRound size={size === 'md' ? 12 : 10} /> Llave vencida
      </span>
    );
  }
  if (restante != null && restante < 24) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full border border-orange/40 bg-orange/10 text-orange ${padding} ${className}`}
        title={`La llave de ImporChat vence en ~${Math.max(1, Math.round(restante))}h y no se está renovando sola. Revisá la configuración.`}>
        <KeyRound size={size === 'md' ? 12 : 10} /> Llave vence en {Math.max(1, Math.round(restante))}h
      </span>
    );
  }

  const status = q.data.status;
  const Icon = STATUS_ICON[status];
  const hours = q.data.lastSyncAt ? (Date.now() - q.data.lastSyncAt.getTime()) / 3_600_000 : null;
  // ⛔ COLGARSE y FALLAR no son lo mismo, y la diferencia cambia dónde hay que
  // buscar: una corrida que falla deja un error en el log; una que se cuelga no
  // deja NADA — la fila se queda en «running» para siempre. Decir "falla al
  // sincronizar" sobre un cuelgue manda a buscar un error que no existe.
  // Además la última corrida pudo terminar BIEN: las colgadas son las de antes.
  const colgado = q.data.colgadas > 0;
  const text = colgado
    ? 'ImporChat: se está colgando'
    : status === 'failing'
      ? 'ImporChat: falla al sincronizar'
      : status === 'never'
        ? 'ImporChat sin correr'
        : `ImporChat ${formatRelative(hours)}`;
  const title = colgado
    ? `${q.data.colgadas} de las últimas ${q.data.corridasVistas} corridas del sync de ImporChat arrancaron y nunca terminaron. `
      + 'Durante esas ventanas el WhatsApp del cliente NO entró: puede haber gente esperando respuesta que no aparece en ninguna pantalla.'
    : status === 'failing'
      ? `La última corrida del sync de ImporChat falló${q.data.lastErrorMessage ? `: ${q.data.lastErrorMessage}` : ''}. Puede que el inbound no esté entrando.`
      : q.data.lastSyncAt
        ? `Último sync de ImporChat: ${q.data.lastSyncAt.toLocaleString('es-CO')}`
        : 'Sin corridas del sync de ImporChat';

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border tabular-nums ${STATUS_CLS[status]} ${padding} ${className}`} title={title}>
      <Icon size={size === 'md' ? 12 : 10} />
      <span>{text}</span>
    </span>
  );
}
