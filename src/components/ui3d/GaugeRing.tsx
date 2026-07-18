import { useCountUp } from './useCountUp';

/**
 * Porcentaje → grados para el conic-gradient. Recorta fuera de rango y trata
 * NaN como 0: un NaN acá rompe el gradiente y deja el anillo en blanco.
 */
export function pctToDegrees(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct)) * 3.6;
}

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
}

/**
 * Anillo tipo gauge del handoff: arco cónico índigo→violeta→cian sobre pista
 * tenue, con halo que gira, marcas de tick y la cifra contando al centro.
 *
 * El arco se dibuja con conic-gradient + mask radial (un donut), más barato de
 * animar que un stroke SVG. Presentación pura.
 */
export default function GaugeRing({
  value, label, size = 210, thickness = 20, duration = 1100,
}: GaugeRingProps) {
  const shown = useCountUp(value, duration);
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
          background: 'conic-gradient(from 0deg, hsl(var(--accent)), hsl(var(--accent2)), hsl(var(--cyan)), hsl(var(--accent)))',
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
          background: `conic-gradient(from 200deg, hsl(var(--accent)) 0deg, hsl(var(--accent2)) ${deg * 0.55}deg, hsl(var(--cyan)) ${deg}deg, hsl(var(--foreground) / .06) ${deg}deg)`,
          WebkitMask: donutMask,
          mask: donutMask,
          boxShadow: '0 0 50px -6px hsl(var(--accent) / .6)',
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
        <div className="font-mono tabular-nums font-bold leading-none text-foreground num-glow-accent" style={{ fontSize: size * 0.27 }}>
          {Math.round(shown)}
          <span className="text-accent2" style={{ fontSize: size * 0.115 }}>%</span>
        </div>
        {label && <div className="text-[11px] text-muted-foreground mt-1">{label}</div>}
      </div>
    </div>
  );
}
