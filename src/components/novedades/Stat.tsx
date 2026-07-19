import { ReactNode } from 'react';
import { TiltCard, CountUp } from '@/components/ui3d';

export type StatTone = 'default' | 'danger' | 'success' | 'warning' | 'info';

/** KPI card compacta con chip de ícono por tono. Compartida por los tableros
 *  de /novedades (Seguimiento, Puntos de mejora y Causa raíz).
 *
 *  Misma anatomía que el `StatTile` del Dashboard — chip 36px arriba, cifra de
 *  34px contando, rótulo HUD, apoyo al pie — pero acepta `string` porque acá
 *  hay valores ya formateados (porcentajes, pesos) y el centinela «—».
 *
 *  Un «—» (sin dato) y un 0 medido se dibujan atenuados igual que en el
 *  Dashboard: un cero apagado se lee distinto de un dato real. Nunca se
 *  convierte «—» en 0 para que la tarjeta se vea llena. */
export function Stat({
  icon, label, value, hint, tone = 'default',
}: {
  icon?: ReactNode; label: string; value: string | number; hint?: string; tone?: StatTone;
}) {
  const chip = {
    default: 'bg-muted/60 border-border text-muted-foreground',
    danger: 'bg-danger/14 border-danger/30 text-danger glow-danger',
    success: 'bg-success/14 border-success/30 text-success glow-success',
    warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
    info: 'bg-info/14 border-info/30 text-info glow-info',
  }[tone];
  const valColor = {
    default: 'text-foreground', danger: 'text-danger', success: 'text-success',
    warning: 'text-warning', info: 'text-info',
  }[tone];
  // index.css solo define num-glow para accent/success/danger — el resto va sin
  // glow en vez de inventar un token que no existe.
  const valGlow = { default: '', danger: 'num-glow-danger', success: 'num-glow-success', warning: '', info: '' }[tone];

  // TRES estados, no dos. Un CERO MEDIDO ("contamos y dieron cero") y un SIN
  // DATO ("no pudimos medir") no son lo mismo, y si se dibujan idénticos la
  // jerarquía visual borra justo la distinción que el texto sí conserva.
  //  · lleno   → cifra a todo color con glow.
  //  · cero    → atenuado, pero borde SÓLIDO: es una medición real.
  //  · sin dato→ atenuado y borde PUNTEADO: no hay medición atrás. La forma
  //    del borde es la señal, así que se distingue sin percibir color.
  const isNoData = value === '—';
  const isZero = value === 0;
  const dimmed = isNoData || isZero;

  return (
    <TiltCard
      perspective={1200}
      className={`bg-card/40 border rounded-2xl p-4 h-full flex flex-col justify-between shadow-card3d ${
        isNoData ? 'border-border/50 border-dashed opacity-75' : isZero ? 'border-border/50 opacity-75' : 'border-border'
      }`}
    >
      {icon && (
        <span
          className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 tilt-layer-2 ${chip}`}
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <div
        className={`font-mono text-[34px] font-bold leading-none tabular-nums mt-3 tilt-layer-3 ${
          dimmed ? 'text-muted-foreground' : `${valColor} ${valGlow}`
        }`}
        title={isNoData ? 'Sin dato: no se pudo medir' : undefined}
      >
        {typeof value === 'number' ? <CountUp value={value} /> : value}
      </div>
      <div className="hud-label text-subtle mt-2 tilt-layer-1">{label}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-1 tilt-layer-1">{hint}</div>}
    </TiltCard>
  );
}
