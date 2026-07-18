export interface DayBar {
  /** Etiqueta del eje (ej. "18 jul"). */
  date: string;
  conf: number;
  canc: number;
  noresp: number;
  /** Marca la columna del día actual. */
  esHoy?: boolean;
}

interface StackedDayBarsProps {
  data: DayBar[];
  /** Alto del área de barras en px. */
  height?: number;
}

/** Alto mínimo de un segmento para que su número quepa adentro sin recortarse. */
const MIN_SEGMENT_PX = 16;

/**
 * Barras apiladas con el número IMPRESO dentro de cada segmento (patrón del
 * handoff), y la columna de hoy resaltada con contorno cian.
 *
 * Existe para períodos CORTOS: con 7 columnas cada barra tiene ~30px de ancho y
 * los números entran. A 15 o 30 días no caben — ahí el Dashboard sigue usando
 * el BarChart de recharts, que da tooltip y ejes.
 *
 * Presentación pura: recibe la serie ya calculada.
 */
export default function StackedDayBars({ data, height = 150 }: StackedDayBarsProps) {
  const totales = data.map(d => d.conf + d.canc + d.noresp);
  const max = Math.max(1, ...totales);

  return (
    <div className="flex items-end justify-between gap-2.5" style={{ height }}>
      {data.map((d, i) => {
        const total = d.conf + d.canc + d.noresp;
        // Altura proporcional al día más cargado del período.
        const alturaTotal = total === 0 ? 3 : Math.max(MIN_SEGMENT_PX, Math.round((total / max) * height));
        const px = (n: number) => (total === 0 ? 0 : Math.round((n / total) * alturaTotal));

        // De arriba hacia abajo: no respondió · cancelados · confirmados.
        // Lo bueno queda en la base, que es donde la vista aterriza primero.
        const segmentos = [
          { n: d.noresp, cls: 'bg-muted-foreground/45 text-foreground', label: 'no respondió' },
          { n: d.canc, cls: 'bg-danger text-danger-foreground', label: 'cancelados' },
          { n: d.conf, cls: 'bg-success text-success-foreground', label: 'confirmados' },
        ].filter(s => s.n > 0);

        return (
          <div key={`${d.date}-${i}`} className="flex flex-col items-center gap-2 flex-1 min-w-0">
            <div
              className="w-full max-w-[30px] rounded-t-lg overflow-hidden flex flex-col origin-bottom animate-gb-rise"
              style={{
                height: alturaTotal,
                animationDelay: `${i * 80}ms`,
                ...(d.esHoy
                  ? {
                      outline: '1.5px solid hsl(var(--cyan) / 0.7)',
                      outlineOffset: 2,
                      boxShadow: '0 0 20px -2px hsl(var(--success) / 0.55)',
                    }
                  : {}),
              }}
              title={`${d.date} — ${d.conf} confirmados · ${d.canc} cancelados · ${d.noresp} no respondió`}
            >
              {segmentos.map(s => {
                const h = px(s.n);
                return (
                  <div
                    key={s.label}
                    className={`flex items-center justify-center ${s.cls}`}
                    style={{ height: h, flex: s.label === 'confirmados' ? 1 : undefined }}
                  >
                    {/* El número solo se dibuja si el segmento le da altura;
                        si no, se recortaría a la mitad y se leería peor que nada. */}
                    {h >= MIN_SEGMENT_PX && (
                      <span className="font-mono tabular-nums font-extrabold text-[11px] leading-none">
                        {s.n}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <span
              className={
                d.esHoy
                  ? 'font-mono text-[9px] font-bold tracking-[0.1em] text-cyan'
                  : 'text-[10px] text-muted-foreground truncate max-w-full'
              }
            >
              {d.esHoy ? 'HOY' : d.date}
            </span>
          </div>
        );
      })}
    </div>
  );
}
