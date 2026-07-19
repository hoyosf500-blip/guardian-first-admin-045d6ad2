import { TrendingUp, TrendingDown, DollarSign, Target } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { TiltCard } from '@/components/ui3d';

interface FinanzasHeroProps {
  gananciaNeta: number;
  totalEntradas: number;
  totalSalidas: number;
  ingresosBrutos: number;
  totalEntregadas: number;
  /** null = margen indefinido (sin denominador). Se pinta '—' en tono neutro,
   *  nunca 0.0% en rojo — mismo criterio que `utilidad_neta` en CfoTab. */
  margenPct: number | null;
  /** true = el valor es el operativo por cohorte (real); false = caja del wallet
   *  por fecha de pago (mezcla meses). Cambia el subtítulo y la microcopy. */
  cohorte?: boolean;
  isLoading?: boolean;
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

/** Tokens por tono para el aro. Nada hardcodeado: todo sale de index.css.
 *  `soft` es el mismo token con alpha, para el degradado del arco. */
const RING_STROKE: Record<Tone, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  danger:  'hsl(var(--danger))',
  neutral: 'hsl(var(--muted-foreground))',
};

const RING_STROKE_SOFT: Record<Tone, string> = {
  success: 'hsl(var(--success) / 0.5)',
  warning: 'hsl(var(--warning) / 0.5)',
  danger:  'hsl(var(--danger) / 0.5)',
  neutral: 'hsl(var(--muted-foreground) / 0.5)',
};

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  neutral: 'text-muted-foreground',
};

const TONE_CHIP: Record<Tone, string> = {
  success: 'bg-success/14 border-success/30 text-success glow-success',
  warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
  danger:  'bg-danger/14 border-danger/30 text-danger glow-danger',
  neutral: 'bg-muted/60 border-border text-muted-foreground',
};

const TONE_VEREDICTO: Record<Tone, string> = {
  success: 'bg-success/10 border-success/25 text-success',
  warning: 'bg-warning/10 border-warning/25 text-warning',
  danger:  'bg-danger/10 border-danger/25 text-danger',
  neutral: 'bg-muted/50 border-border text-muted-foreground',
};

/**
 * Aro de margen — receta cruda del lenguaje del Dashboard (conic-gradient +
 * máscara donut), NO el <GaugeRing/> de ui3d.
 *
 * Motivo de no reusar GaugeRing, que sería lo natural: (1) su rampa es siempre
 * accent→accent2→cyan, así que el aro se vería idéntico con margen del 4% o del
 * 60% y se perdería el semáforo de los umbrales (≥30 sano · ≥15 tibio · debajo
 * malo) que hoy pinta la cifra; (2) su cifra central es `Math.round(shown)`, y
 * acá el número que se muestra es `toFixed(1)` — redondearlo cambiaría el dato
 * en pantalla (38.5% pasaría a 39%). El aro es presentación; el número que
 * viaja adentro es el mismo string exacto de siempre.
 */
function MargenRing({ pct, tone, size = 154, thickness = 16 }: {
  pct: number; tone: Tone; size?: number; thickness?: number;
}) {
  // `operativoReal` PUEDE SER NEGATIVO (mes con pérdida). Con un simple
  // clamp a 0, un margen de -12.4% dibujaba el aro VACÍO, pixel por pixel
  // idéntico a un margen de 0.0%: perder plata y no ganar nada se veían igual,
  // que es justo lo que el aro venía a resolver. Así que la pérdida se dibuja
  // con su MAGNITUD, en sentido inverso (scaleX(-1) espeja el conic-gradient,
  // el arco crece antihorario) y con textura de rayas. La cifra central sigue
  // siendo el mismo `pct.toFixed(1)` exacto de siempre.
  const isLoss = pct < 0;
  const deg = Math.min(100, Math.abs(pct)) * 3.6;
  const donutMask = `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness - 1}px))`;
  const tickMask = 'radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px))';
  const stroke = RING_STROKE[tone];
  const strokeSoft = RING_STROKE_SOFT[tone];

  return (
    <div className="relative" style={{ width: size, height: size }}>
      {/* Halo difuminado detrás del aro, del color del veredicto. */}
      <div
        aria-hidden="true"
        className="absolute rounded-full blur-2xl opacity-25"
        style={{ inset: -12, background: stroke }}
      />
      {/* Ticks del borde. */}
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
      {/* Pista + arco de progreso, degradado del tono a su versión tenue.
          En PÉRDIDA el arco se espeja: crece al revés, así no se puede
          confundir con un margen positivo chico ni con un cero. */}
      <div
        role="img"
        aria-label={
          isLoss
            ? `Pérdida: margen de ${pct.toFixed(1)}% sobre ingresos brutos`
            : `Margen de ${pct.toFixed(1)}% sobre ingresos brutos`
        }
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(from 200deg, ${strokeSoft} 0deg, ${stroke} ${deg}deg, hsl(var(--foreground) / .06) ${deg}deg)`,
          WebkitMask: donutMask,
          mask: donutMask,
          boxShadow: `0 0 44px -8px ${stroke}`,
          transform: isLoss ? 'scaleX(-1)' : undefined,
        }}
      />
      {/* Rayado SOLO en pérdida, recortado al mismo arco: refuerza el sentido
          inverso para quien no percibe la dirección del giro. */}
      {isLoss && (
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-full opacity-60"
          style={{
            background: `repeating-linear-gradient(45deg, hsl(var(--background) / .55) 0 3px, transparent 3px 7px)`,
            WebkitMask: `${donutMask}, conic-gradient(from 200deg, #000 0deg ${deg}deg, transparent ${deg}deg)`,
            mask: `${donutMask}, conic-gradient(from 200deg, #000 0deg ${deg}deg, transparent ${deg}deg)`,
            WebkitMaskComposite: 'source-in',
            maskComposite: 'intersect',
            transform: 'scaleX(-1)',
          }}
        />
      )}
      {/* Sheen que gira encima. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full opacity-40 animate-gb-spin"
        style={{
          background: 'conic-gradient(from 0deg, transparent, hsl(var(--foreground) / .35), transparent 40%)',
          WebkitMask: donutMask,
          mask: donutMask,
          animationDuration: '6s',
        }}
      />
      {/* Cifra central — un SOLO nodo de texto con el mismo toFixed(1) de antes. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className={`font-mono tabular-nums font-bold leading-none text-[28px] ${TONE_TEXT[tone]}`}>
          {pct.toFixed(1)}%
        </div>
      </div>
    </div>
  );
}

export default function FinanzasHero({
  gananciaNeta, totalEntradas, totalSalidas,
  ingresosBrutos, totalEntregadas, margenPct,
  cohorte = false,
  isLoading = false,
}: FinanzasHeroProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-5 rounded-3xl border border-border bg-card/40 shadow-card3d-lg animate-pulse h-[196px]" />
        <div className="md:col-span-4 rounded-2xl border border-border bg-card/40 shadow-card3d animate-pulse h-[196px]" />
        <div className="md:col-span-3 rounded-2xl border border-border bg-card/40 shadow-card3d animate-pulse h-[196px]" />
      </div>
    );
  }

  const isPositive = gananciaNeta >= 0;
  // Sin ingresos brutos no hay denominador: el margen es INDEFINIDO, no 0%.
  // Antes llegaba como 0 y se pintaba "0.0%" en ROJO junto a "Sano: ≥30%" — un
  // dato ausente disfrazado de mal resultado. Los umbrales NO cambian; lo único
  // que cambia es que solo se evalúan cuando hay valor de verdad.
  const margenValue =
    margenPct == null || !Number.isFinite(margenPct) || ingresosBrutos <= 0
      ? null
      : margenPct;
  const margenTone: Tone =
    margenValue == null ? 'neutral' :
    margenValue >= 30 ? 'success' :
    margenValue >= 15 ? 'warning' :
    'danger';

  const netoTone: Tone = isPositive ? 'success' : 'danger';

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
      {/* ── Hero principal — Ganancia Neta REAL.
          Única card de la pantalla con sheen + brackets: si dos llevaran
          brackets, ninguna sería la protagonista. */}
      <TiltCard
        sheen
        brackets
        wrapperClassName="md:col-span-5"
        className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full flex flex-col"
      >
        <div className="flex items-start justify-between gap-3 tilt-layer-2">
          <span
            className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${TONE_CHIP[netoTone]}`}
          >
            {isPositive ? <TrendingUp size={17} aria-hidden="true" /> : <TrendingDown size={17} aria-hidden="true" />}
          </span>
        </div>

        <div
          className={`mt-4 text-3xl sm:text-[38px] font-mono tabular-nums font-bold tracking-tight leading-none tilt-layer-3 ${
            TONE_TEXT[netoTone]
          } ${isPositive ? 'num-glow-success' : 'num-glow-danger'}`}
        >
          {formatCOP(gananciaNeta)}
        </div>

        <div className="hud-label text-subtle mt-2.5 tilt-layer-1">
          Ganancia Neta Dropi {cohorte ? '(cohorte del mes)' : '(caja · fecha de pago)'}
        </div>

        {/* Desglose in/out: swatches cuadrados de 10px (nunca círculos) y las
            cifras en mono, como toda barra de leyenda del lenguaje. */}
        <div className="mt-3.5 flex items-center gap-2.5 flex-wrap tilt-layer-1">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border bg-success/10 border-success/25 text-[11px]">
            <span className="w-2.5 h-2.5 rounded-[3px] bg-success" aria-hidden="true" />
            <span className="font-mono tabular-nums font-semibold text-success">{formatCOP(totalEntradas)}</span>
            <span className="text-muted-foreground">in</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border bg-danger/10 border-danger/25 text-[11px]">
            <span className="w-2.5 h-2.5 rounded-[3px] bg-danger" aria-hidden="true" />
            <span className="font-mono tabular-nums font-semibold text-danger">{formatCOP(totalSalidas)}</span>
            <span className="text-muted-foreground">out</span>
          </span>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed tilt-layer-1">
          {cohorte
            ? 'Operativo por cohorte (pedidos creados en el mes): '
            : 'Caja del wallet por fecha de pago (mezcla meses): '}
          entró {formatCOP(totalEntradas)} − te debitó {formatCOP(totalSalidas)}.
        </p>
      </TiltCard>

      {/* ── Margen Operativo — el aro es lo que cambia: el número dejó de ser
          una cifra suelta y pasó a leerse contra la escala completa. */}
      <TiltCard
        wrapperClassName="md:col-span-4"
        className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full flex flex-col"
      >
        <div className="flex items-start justify-between gap-3 tilt-layer-2">
          <span
            className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${TONE_CHIP[margenTone]}`}
          >
            <Target size={17} aria-hidden="true" />
          </span>
          <span className="hud-label text-subtle text-right leading-tight max-w-[130px]">
            Margen Operativo (indicativo)
          </span>
        </div>

        <div className="flex justify-center py-3 tilt-layer-3">
          {margenValue == null ? (
            /* Sin medición NO se dibuja un aro en 0% — sería un dato inventado
               con el mismo peso visual que un margen real de 0. Círculo
               punteado con '—', mismo patrón que el gauge del Dashboard. */
            <div
              className="flex flex-col items-center justify-center rounded-full border border-dashed border-border bg-muted/20 text-center px-6"
              style={{ width: 154, height: 154 }}
              role="img"
              aria-label="Margen operativo sin datos: no hay ingresos brutos en el período"
            >
              <span className="text-4xl font-bold text-muted-foreground leading-none">—</span>
            </div>
          ) : (
            <MargenRing pct={margenValue} tone={margenTone} />
          )}
        </div>

        <div className="text-[11px] text-muted-foreground leading-snug tilt-layer-1">
          {margenValue != null ? (
            <>
              {/* El umbral de negocio va en chip NEUTRO a propósito. Teñirlo con
                  el semáforo de la medición hacía que una tienda con 5% de margen
                  leyera un chip ROJO que dice "Sano: ≥30%": el color afirmaba una
                  cosa y el texto otra. Esto es la META, no el veredicto — el
                  semáforo vive en la cifra y en el aro, que son la medición. */}
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold mb-2 ${TONE_VEREDICTO.neutral}`}
              >
                Sano: ≥30%
              </span>
              <span className="block">Ganancia neta sobre ingresos brutos.</span>
              {/* El calificador que ya llevan las otras dos cards. El numerador y el
                  denominador NO son la misma cohorte, así que el % no es comparable
                  mes a mes con precisión contable — se dice en vez de callarlo. */}
              <span className="block mt-1">
                Cruza cohortes: arriba va {cohorte ? 'por fecha de pedido' : 'por fecha de pago'} y
                los ingresos por entregados del período.
              </span>
            </>
          ) : (
            <>Sin datos: no hay ingresos brutos en el período, así que el margen no se puede calcular.</>
          )}
        </div>
      </TiltCard>

      {/* ── Ingresos Brutos */}
      <TiltCard
        wrapperClassName="md:col-span-3"
        className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full flex flex-col"
      >
        <div className="flex items-start justify-between gap-2 tilt-layer-2">
          <span className="w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 bg-info/14 border-info/30 text-info glow-info">
            <DollarSign size={17} aria-hidden="true" />
          </span>
        </div>

        <div className="mt-4 text-2xl sm:text-[30px] font-mono tabular-nums font-bold tracking-tight leading-none text-info tilt-layer-3">
          {formatCOP(ingresosBrutos)}
        </div>

        <div className="hud-label text-subtle mt-2.5 tilt-layer-1">
          Ingresos Brutos
        </div>

        {/* Conteo crudo de entregadas. No lleva barra: no hay denominador a mano
            en este componente contra el cual dibujar una proporción honesta. */}
        <div className="mt-auto pt-4 tilt-layer-1">
          <div className="text-[11px] text-muted-foreground">
            <span className="font-mono tabular-nums font-semibold text-foreground">{totalEntregadas}</span> órdenes entregadas en el período
          </div>
        </div>
      </TiltCard>
    </div>
  );
}
