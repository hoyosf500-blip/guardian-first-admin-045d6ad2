import { useState, useEffect } from 'react';
import { Info, X } from 'lucide-react';
import { bogotaToday } from '@/lib/utils';

// Banner one-shot para anunciar cambios en métricas. Persiste el dismiss
// en localStorage por `id` para no molestar después del primer cierre.
// `expiresAt` (YYYY-MM-DD, hora Bogotá) evita banners zombi: pasada esa
// fecha el banner deja de renderizarse aunque la operadora no lo haya
// cerrado, así no contaminamos la UI 30 días después del rollout.
// Color info (azul) por design tokens — no hardcodea HSL.
interface Props {
  id: string;
  message: string;
  expiresAt?: string;
}

export function MetricsUpdateBanner({ id, message, expiresAt }: Props) {
  const storageKey = `metrics-banner-dismissed:${id}`;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (expiresAt && bogotaToday() > expiresAt) {
      setVisible(false);
      return;
    }
    // Audit M7: try-catch evita crash en Safari modo privado donde localStorage tira SecurityError.
    try {
      setVisible(!localStorage.getItem(storageKey));
    } catch {
      setVisible(true);
    }
  }, [storageKey, expiresAt]);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="rounded-xl border border-info/30 bg-info/5 px-4 py-2.5 flex items-center gap-3"
    >
      <Info size={16} className="text-info shrink-0" aria-hidden="true" strokeWidth={2.25} />
      <p className="text-sm text-foreground flex-1 min-w-0">{message}</p>
      <button
        type="button"
        onClick={() => {
          try { localStorage.setItem(storageKey, '1'); } catch { /* ignore quota */ }
          setVisible(false);
        }}
        className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label="Cerrar aviso"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
