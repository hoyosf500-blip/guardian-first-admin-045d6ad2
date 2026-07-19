import { useCountUp } from './useCountUp';

/**
 * Porcentaje → grados para el conic-gradient. Recorta fuera de rango y trata
 * NaN como 0: un NaN acá rompe el gradiente y deja el anillo en blanco.
 */
export function pctToDegrees(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct)) * 3.6;
}

/** Rampa del arco por tono. `brand` es la de siempre (índigo→violeta→cian). */
export type GaugeTone = 'brand' | 'success' | 'warning' | 'danger';

const TONE_RAMP: Record<GaugeTone, { start: string; mid: string; end: string; halo: string; num: string; pct: string }> = {
  brand:   { start: 'hsl(var(--accent))',        mid: 'hsl(var(--accent2))',      end: 'hsl(var(--cyan))',    halo: 'hsl(var(--accent) / .6)',  num: 'num-glow-accent',  pct: 'text-accent2' },
  success: { start: 'hsl(var(--success) / .55)', mid: 'hsl(var(--success) / .8)', end: 'hsl(var(--success))', halo: 'hsl(var(--success) / .6)', num: 'num-glow-success', pct: 'text-success' },
  // index.css no define num-glow-warning — va sin glow en vez de inventar token.
  warning: { start: 'hsl(var(--warning) / .55)', mid: 'hsl(var(--warning) / .8)', end: 'hsl(var(--warning))', halo: 'hsl(var(--warning) / .6)', num: '',                 pct: 'text-warning' },
  danger:  { start: 'hsl(var(--danger) / .55)',  mid: 'hsl(var(--danger) / .8)',  end: 'hsl(var(--danger))',  halo: 'hsl(var(--danger) / .6)',  num: 'num-glow-danger',  pct: 'text-danger' },
};

interface GaugeRingProps {
  /** Porcentaje 0-100. */
  value: number;
  /** Texto bajo la cifra (ej. "confirmación"). */
  label?: string;
  /** Diámetro en px. */
  size?: number;
  /** Grosor del anillo en px. */
  thickness?: number;
  duration?: number;
  /**
   * Tono del arco. Default `brand` = la rampa de siempre, así que los
   * call-sites que no lo pasan renderizan EXACTAMENTE igual que antes.
   *
   * Existe porque el aro es el elemento más grande de su tarjeta: en una card
   * teñida de rojo por urgencia, un arco índigo "sano" contradecía justo lo
   * que la tarjeta intentaba comunicar.
   */
  tone?: GaugeTone;
}

/**
 * Anillo tipo gauge del handoff: arco cónico índigo→violeta→cian sobre pista
 * tenue, con halo que gira, marcas de tick y la cifra contando al centro.
 *
 * El arco se dibuja con conic-gradient + mask radial (un donut), más barato de
 * animar que un stroke SVG. Presentación pura.
 */
export default function GaugeRing({
  value, label, size = 210, thickness = 20, duration = 1100, tone = 'brand',
}: GaugeRingProps) {
  const shown = useCountUp(value, duration);
  const ramp = TONE_RAMP[tone] ?? TONE_RAMP.brand;
  const deg = pctToDegrees(shown);
  const donutMask = `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness - 1}px))`;
  const tickMask = 'radial-gradient(farthest-side, transparent calc(100% - 7px), #000 calc(100% - 6px))';

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ? `Tasa de ${label}` : 'Tasa'}
      className="relative"
      style={{ width: size, height: size }}
    >
      {/* Halo difuminado que gira lento detrás del anillo */}
      <div
        aria-hidden="true"
        className="absolute rounded-full blur-2xl opacity-30 animate-gb-spin"
        style={{
          inset: -16,
          background: `conic-gradient(from 0deg, ${ramp.start}, ${ramp.mid}, ${ramp.end}, ${ramp.start})`,
        }}
      />
      {/* Marcas de tick del borde */}
      <div
        aria-hidden="true"
        className="absolute rounded-full opacity-50"
        style={{
          inset: -3,
          background: 'repeating-conic-gradient(from -90deg, hsl(var(--foreground) / .30) 0deg .7deg, transparent .7deg 15deg)',
          WebkitMask: tickMask,
          mask: tickMask,
        }}
      />
      {/* Pista + arco de progreso */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(from 200deg, ${ramp.start} 0deg, ${ramp.mid} ${deg * 0.55}deg, ${ramp.end} ${deg}deg, hsl(var(--foreground) / .06) ${deg}deg)`,
          WebkitMask: donutMask,
          mask: donutMask,
          boxShadow: `0 0 50px -6px ${ramp.halo}`,
        }}
      />
      {/* Sheen que gira sobre el anillo */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full opacity-50 animate-gb-spin"
        style={{
          background: 'conic-gradient(from 0deg, transparent, hsl(var(--foreground) / .35), transparent 40%)',
          WebkitMask: donutMask,
          mask: donutMask,
          animationDuration: '5s',
        }}
      />
      {/* Cifra central */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className={`font-mono tabular-nums font-bold leading-none text-foreground ${ramp.num}`} style={{ fontSize: size * 0.27 }}>
          {Math.round(shown)}
          <span className={ramp.pct} style={{ fontSize: size * 0.115 }}>%</span>
        </div>
        {label && <div className="text-[11px] text-muted-foreground mt-1">{label}</div>}
      </div>
    </div>
  );
}
