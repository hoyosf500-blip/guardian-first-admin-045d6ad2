import type { ElementType } from 'react';

export type KpiTone = 'success' | 'danger' | 'info' | 'warning' | 'neutral' | 'accent';

const TONE_TEXT: Record<KpiTone, string> = {
  success: 'text-success',
  danger:  'text-danger',
  info:    'text-info',
  warning: 'text-warning',
  accent:  'text-accent',
  neutral: 'text-foreground',
};

const TONE_ICON_BG: Record<KpiTone, string> = {
  success: 'bg-success/10 border-success/30',
  danger:  'bg-danger/10 border-danger/30',
  info:    'bg-info/10 border-info/30',
  warning: 'bg-warning/10 border-warning/30',
  accent:  'bg-accent/10 border-accent/30',
  neutral: 'bg-muted/40 border-border',
};

export interface KpiCardProps {
  label: string;
  value: string;
  icon: ElementType;
  tone: KpiTone;
  hint?: string;
  size?: 'sm' | 'md' | 'lg';
}

export default function KpiCard({
  label, value, icon: Icon, tone, hint, size = 'md',
}: KpiCardProps) {
  const colorClass = TONE_TEXT[tone];
  const iconBg = TONE_ICON_BG[tone];

  const valueSize =
    size === 'lg' ? 'text-3xl sm:text-4xl' :
    size === 'sm' ? 'text-base' :
    'text-2xl';

  return (
    <div className="card-elevated p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground leading-tight">
          {label}
        </span>
        <div className={`h-8 w-8 rounded-lg border flex items-center justify-center shrink-0 ${iconBg}`}>
          <Icon size={14} className={colorClass} aria-hidden="true" />
        </div>
      </div>
      <div className={`mt-3 font-bold tabular-nums leading-none ${colorClass} ${valueSize}`}>
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-[11px] text-muted-foreground leading-snug">{hint}</div>
      )}
    </div>
  );
}
