/**
 * Convierte una serie en el atributo `points` de un <polyline>.
 *
 * El eje Y va invertido (en SVG, y=0 es arriba). Si todos los valores son
 * iguales el rango es 0 y la línea se dibuja plana al medio — sin dividir
 * por cero.
 */
export function buildPolylinePoints(data: number[], width: number, height: number): string {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;
  const stepX = width / (data.length - 1);

  return data
    .map((value, i) => {
      const x = i * stepX;
      const norm = range === 0 ? 0.5 : (value - min) / range;
      const y = height - norm * height;
      return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    })
    .join(' ');
}

interface SparklineProps {
  data: number[];
  /** Color del trazo. Pasar un token: `hsl(var(--success))`. */
  color: string;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Línea de tendencia que se dibuja al montar (stroke-dashoffset).
 *
 * Es decorativa: va con aria-hidden porque el número que acompaña ya comunica
 * el dato. Presentación pura.
 */
export default function Sparkline({
  data, color, width = 120, height = 30, className = '',
}: SparklineProps) {
  const points = buildPolylinePoints(data, width, height);
  if (!points) return null;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={className}
      style={{ overflow: 'visible' }}
    >
      <polyline
        className="spark-draw animate-gb-draw"
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 5px ${color})` }}
      />
    </svg>
  );
}
