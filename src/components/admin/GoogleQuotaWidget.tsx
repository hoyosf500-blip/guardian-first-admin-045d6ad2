// src/components/admin/GoogleQuotaWidget.tsx
import { Activity, AlertTriangle } from 'lucide-react';
import { useGoogleQuota } from '@/hooks/useGoogleQuota';

export function GoogleQuotaWidget() {
  const { data, isLoading } = useGoogleQuota();

  if (isLoading || !data) {
    return <div className="rounded-2xl border border-border bg-card/40 p-3 text-sm text-muted-foreground shadow-card3d hairline-top">Cargando cuota Google…</div>;
  }

  const pct = Math.round(data.pct * 100);
  const tone = data.exceeded ? 'danger' : data.pct > 0.8 ? 'warning' : 'info';

  const toneClass = tone === 'danger'
    ? 'border-danger/40 bg-danger/10 text-danger'
    : tone === 'warning'
      ? 'border-warning/40 bg-warning/10 text-warning'
      : 'border-info/40 bg-info/10 text-info';

  const Icon = tone === 'danger' || tone === 'warning' ? AlertTriangle : Activity;

  return (
    <div className={`rounded-2xl border p-3 text-sm shadow-card3d ${toneClass}`}>
      <div className="flex items-center gap-2 font-medium">
        <Icon size={14} />
        <span>Cuota Google API hoy</span>
      </div>
      <div className="mt-2 text-foreground tabular-nums">
        Usado: <span className="font-semibold">${data.used_usd.toFixed(2)}</span> / ${data.budget_usd.toFixed(2)} ({pct}%)
      </div>
      <div className="mt-1 text-xs text-muted-foreground">Fecha: {data.used_today_date}</div>
      {data.exceeded && (
        <div className="mt-2 text-xs text-danger">Cuota excedida — autocomplete deshabilitado hasta mañana</div>
      )}
    </div>
  );
}
