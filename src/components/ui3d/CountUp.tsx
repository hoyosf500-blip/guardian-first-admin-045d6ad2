import { useCountUp } from './useCountUp';

interface CountUpProps {
  value: number;
  /** Milisegundos de animación. 0 = sin animar (útil en tests). */
  duration?: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  className?: string;
}

/**
 * Cifra que sube desde 0 hasta su valor al montar, en JetBrains Mono con
 * tabular-nums (regla de oro del handoff: todo número va en mono).
 *
 * Presentación pura: recibe un number, no consulta nada.
 */
export default function CountUp({
  value, duration = 1100, decimals = 0, suffix = '', prefix = '', className = '',
}: CountUpProps) {
  const shown = useCountUp(value, duration, decimals);

  return (
    <span className={`font-mono tabular-nums ${className}`}>
      {prefix}{shown.toFixed(decimals)}{suffix}
    </span>
  );
}
