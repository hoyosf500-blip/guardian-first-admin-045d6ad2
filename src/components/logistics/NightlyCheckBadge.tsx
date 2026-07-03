import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Loader2 } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useNightlyReconcileHealth, type NightlyStatus } from '@/hooks/useNightlyReconcileHealth';

// Badge "verificado contra Dropi" para el header de "Cómo voy". Responde la
// pregunta que el dueño se hacía a mano cada mes ("¿me puedo fiar de estos
// números o Dropi dice otra cosa?"): cada noche dropi-nightly-reconcile barre
// TODO el rango de 30 días contra Dropi, corrige divergencias y cancela pedidos
// borrados; este badge muestra si esa verificación pasó anoche o no.
//
// Distinto del OrdersSyncBadge (frescura del cron de 5 min = "llegan cambios"):
// este mide "los números fueron CONTRASTADOS contra Dropi". Verde = confiá.
// Amarillo = anoche Dropi throttleó y no se pudo contrastar (se reintenta esta
// noche). Rojo = la verificación no está corriendo — avisá.

interface Props {
  size?: 'sm' | 'md';
  className?: string;
}

const TONE_CLS: Record<Exclude<NightlyStatus, 'hidden'>, string> = {
  verified: 'border-success/40 bg-success/10 text-success',
  unverified: 'border-orange/40 bg-orange/10 text-orange',
  error: 'border-danger/40 bg-danger/10 text-danger',
};

const TONE_ICON: Record<Exclude<NightlyStatus, 'hidden'>, React.ElementType> = {
  verified: ShieldCheck,
  unverified: ShieldAlert,
  error: ShieldX,
};

function formatRelative(date: Date | null): string {
  if (!date) return 'nunca';
  const hours = (Date.now() - date.getTime()) / 3_600_000;
  if (hours < 24) return 'anoche';
  const days = Math.round(hours / 24);
  return `hace ${days} día${days > 1 ? 's' : ''}`;
}

// Re-render cada 60s para que el relativo avance sin re-fetch (patrón OrdersSyncBadge).
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

export default function NightlyCheckBadge({ size = 'sm', className = '' }: Props) {
  const { activeStoreId } = useStore();
  const q = useNightlyReconcileHealth(activeStoreId);
  useMinuteTick();

  if (q.isLoading) {
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] text-muted-foreground ${className}`}>
        <Loader2 size={10} className="animate-spin" />
        verificando…
      </span>
    );
  }

  // Sin corridas / sin permiso RLS / error de query → ocultar (no alarmar en falso).
  if (q.isError || !q.data || q.data.status === 'hidden') return null;

  const { status, lastVerifiedAt, consecutiveUnverified, lastCancelled, lastApplied, lastErrorMessage } = q.data;
  const tone = status as Exclude<NightlyStatus, 'hidden'>;
  const Icon = TONE_ICON[tone];
  const padding = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]';

  let text: string;
  let title: string;
  if (status === 'verified') {
    text = `Verificado vs Dropi ${formatRelative(lastVerifiedAt)}`;
    const acciones = [
      lastCancelled > 0 ? `${lastCancelled} pedido${lastCancelled > 1 ? 's' : ''} borrado${lastCancelled > 1 ? 's' : ''} en Dropi cancelado${lastCancelled > 1 ? 's' : ''}` : null,
      lastApplied > 0 ? `${lastApplied} divergencia${lastApplied > 1 ? 's' : ''} corregida${lastApplied > 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' · ');
    title = `Cada noche Guardian se contrasta contra Dropi pedido por pedido.${acciones ? ` Anoche: ${acciones}.` : ' Anoche: sin diferencias.'}`;
  } else if (status === 'unverified') {
    const noches = Math.max(1, consecutiveUnverified);
    text = `Sin verificar vs Dropi (${noches} noche${noches > 1 ? 's' : ''})`;
    title = `Dropi limitó las consultas (rate limit) y la verificación nocturna no pudo completarse. Se reintenta esta noche. Última verificación completa: ${formatRelative(lastVerifiedAt)}.`;
  } else {
    text = 'Verificación vs Dropi caída';
    title = lastErrorMessage
      ? `La verificación nocturna falló: ${lastErrorMessage}`
      : 'La verificación nocturna no corre hace más de un día. Avisá para revisarla.';
  }

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
