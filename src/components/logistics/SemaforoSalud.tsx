import { useMemo } from 'react';
import { Activity, Package, Truck, Undo2, Percent, Megaphone, Coins } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFinancialSummary } from '@/hooks/useFinancialSummary';
import { useStoreAdSpendRange, sumAdSpend } from '@/hooks/useStoreAdSpend';
import {
  evalIndicator,
  veredictoLabel,
  type HealthColor,
} from '@/lib/semaforoSalud';

// Semáforo de salud financiera — traído de la competencia (Wintrack).
// Evalúa 6 indicadores del negocio contra estándares fijos del mercado COD y
// pinta un chip de color (verde/amarillo/rojo/gris). Vive en /logistica →
// Resumen, debajo de "Cómo voy".
//
// REGLA DEL DUEÑO: CERO animaciones ni parpadeos. Todo estático y calmo.
// No usar animate-*, pulse, ping, transition de color, etc.
//
// Por esa regla las celdas NO usan <StatTile>/<TiltCard>/<GaugeRing> del
// Dashboard: los tres traen movimiento (tilt con el puntero, CountUp, halo y
// sheen girando). Lo que sí se adopta es su ANATOMÍA — chip de ícono de 36px
// con glow, cifra grande en el color del tono, rótulo en .hud-label bajo la
// cifra, y una barra de referencia al pie — todo dibujado estático acá.

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

/** HealthColor (dominio) → tono del design system (presentación). */
const TONE_BY_COLOR: Record<HealthColor, Tone> = {
  green:  'success',
  yellow: 'warning',
  red:    'danger',
  gray:   'neutral',
};

// Chip de ícono con la fórmula invariable del lenguaje: fondo /14, borde /30,
// texto pleno + glow del tono. El glow es box-shadow: estático, no anima.
const CHIP_CLASS: Record<Tone, string> = {
  success: 'bg-success/14 border-success/30 text-success glow-success',
  warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
  danger:  'bg-danger/14 border-danger/30 text-danger glow-danger',
  neutral: 'bg-muted/60 border-border text-muted-foreground',
};

// Chip de veredicto (recipe del Dashboard): fondo /10, borde /25, rounded-lg.
// Reemplaza al .pill del DS, que trae `transition-colors` y por la regla de
// arriba esta pantalla no puede tener transiciones de color.
const VERDICT_CLASS: Record<Tone, string> = {
  success: 'bg-success/10 border-success/25 text-success',
  warning: 'bg-warning/10 border-warning/25 text-warning',
  danger:  'bg-danger/10 border-danger/25 text-danger',
  neutral: 'bg-muted/50 border-border text-muted-foreground',
};

// Valor grande coloreado por estado (más legible que solo el chip).
const VALUE_CLASS: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  neutral: 'text-muted-foreground',
};

const BAR_CLASS: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger:  'bg-danger',
  neutral: '',
};

/** Dónde cae la marca de la referencia dentro de la pista, en %. */
const REF_MARK_PCT = 60;

interface Indicator {
  label: string;
  /** Valor ya formateado para mostrar (ej "38.0%", "2.3×"). */
  display: string;
  color: HealthColor;
  /** Texto de referencia del estándar, ej "Ref: ≤38%". */
  ref: string;
  /** Micro-frase de contexto/veredicto extendido. */
  hint: string;
  icon: LucideIcon;
  /** Valor crudo para la barra. `null` = sin medición: no se dibuja barra. */
  raw: number | null;
  /** Umbral verde en crudo — el MISMO que ya dice `ref` en texto. */
  refValue: number;
}

function pct(n: number): string {
  if (!isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

/**
 * Ancho de la barra: la referencia se ancla siempre en REF_MARK_PCT de la
 * pista, así que la barra dice "estás por debajo / por encima del estándar"
 * de un vistazo, con cualquier unidad (% o múltiplo).
 *
 * No inventa nada: usa el valor medido y el mismo umbral que la celda ya
 * muestra escrito. Sin medición (`raw === null`) la barra no se dibuja.
 */
function barWidthPct(raw: number, refValue: number): number {
  if (!isFinite(raw) || !isFinite(refValue) || refValue <= 0) return 0;
  // Un CERO MEDIDO tiene que verse como cero. El piso de 2% existe para que una
  // magnitud chiquita no desaparezca, pero aplicado a un 0.0% real (ej. un mes
  // sin pérdida por devoluciones) pintaba una astilla de color donde no hay
  // nada que dibujar. Mismo criterio que TrazabilidadView y el Simulador.
  if (raw <= 0) return 0;
  return Math.max(2, Math.min(100, (raw / refValue) * REF_MARK_PCT));
}

/** Celda individual del semáforo. Estática, sin animaciones. */
function Cell({ ind }: { ind: Indicator }) {
  const tone = TONE_BY_COLOR[ind.color];
  const Icon = ind.icon;
  const width = ind.raw === null ? 0 : barWidthPct(ind.raw, ind.refValue);

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d hairline-top flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <span
          className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${CHIP_CLASS[tone]}`}
        >
          <Icon size={17} aria-hidden="true" />
        </span>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold whitespace-nowrap shrink-0 ${VERDICT_CLASS[tone]}`}
        >
          {veredictoLabel(ind.color)}
        </span>
      </div>

      <div className={`text-[34px] font-mono tabular-nums font-bold leading-none mt-3 ${VALUE_CLASS[tone]}`}>
        {ind.display}
      </div>

      <div className="hud-label mt-2">{ind.label}</div>

      {/* Barra de referencia: pista tenue + marca del estándar. Sin medición
          (gris) no se dibuja — un track vacío se leería como "cero medido". */}
      <div className="mt-3 h-1.5 rounded-full bg-foreground/10 relative overflow-hidden" aria-hidden="true">
        {ind.raw !== null && (
          <div
            className={`h-full rounded-full ${BAR_CLASS[tone]}`}
            style={{ width: `${width}%` }}
          />
        )}
        <span
          className="absolute top-0 bottom-0 w-px bg-foreground/35"
          style={{ left: `${REF_MARK_PCT}%` }}
        />
      </div>

      <div className="mt-2 text-[11px] text-muted-foreground font-mono tabular-nums">{ind.ref}</div>
      <div className="mt-1 text-[11px] text-muted-foreground leading-snug">{ind.hint}</div>
    </div>
  );
}

export default function SemaforoSalud({ from, to }: { from: string; to: string }) {
  const finQuery = useFinancialSummary(from, to);
  // Pauta del período: misma fuente que "Cómo voy" (tabla store_ad_spend_daily,
  // store-scoped). Sumamos todas las filas del rango (Meta + TikTok + otros).
  // retry:false → si la tabla no existe todavía, cae a [] y los indicadores de
  // pauta se muestran en gris ("Registrá tu pauta").
  const adQuery = useStoreAdSpendRange(from, to);
  const pautaTotal = useMemo(
    () => sumAdSpend(adQuery.data ?? []).total,
    [adQuery.data],
  );

  const indicators = useMemo<Indicator[] | null>(() => {
    const f = finQuery.data;
    if (!f || f.ingresos_brutos <= 0) return null;

    const ingresos = f.ingresos_brutos;
    const list: Indicator[] = [];

    // 1. Costo de producto / precio — verde ≤38, amarillo ≤45, rojo >45.
    {
      const v = (f.cogs / ingresos) * 100;
      const color = evalIndicator(v, 'menor', 38, 45);
      list.push({
        label: 'Costo de producto',
        display: pct(v),
        color,
        ref: 'Ref: ≤38%',
        hint: 'Cuánto del precio se va en producto.',
        icon: Package,
        raw: isFinite(v) ? v : null,
        refValue: 38,
      });
    }

    // 2. Costo de fletes — verde ≤20, amarillo ≤25, rojo >25.
    {
      const v = (f.flete_entregadas / ingresos) * 100;
      const color = evalIndicator(v, 'menor', 20, 25);
      list.push({
        label: 'Costo de fletes',
        display: pct(v),
        color,
        ref: 'Ref: ≤20%',
        hint: 'Flete de entregadas sobre ventas.',
        icon: Truck,
        raw: isFinite(v) ? v : null,
        refValue: 20,
      });
    }

    // 3. Impacto de devoluciones — verde ≤3, amarillo ≤6, rojo >6.
    {
      const v = (f.perdida_total_devoluciones / ingresos) * 100;
      const color = evalIndicator(v, 'menor', 3, 6);
      list.push({
        label: 'Impacto de devoluciones',
        display: pct(v),
        color,
        ref: 'Ref: ≤3%',
        hint: 'Plata perdida en devoluciones.',
        icon: Undo2,
        raw: isFinite(v) ? v : null,
        refValue: 3,
      });
    }

    // 4. Margen bruto — MAYOR es mejor. Verde ≥45, amarillo ≥30, rojo <30.
    {
      const v = (f.utilidad_bruta / ingresos) * 100;
      const color = evalIndicator(v, 'mayor', 45, 30);
      list.push({
        label: 'Margen bruto',
        display: pct(v),
        color,
        ref: 'Ref: ≥45%',
        hint: 'Utilidad bruta sobre ventas.',
        icon: Percent,
        raw: isFinite(v) ? v : null,
        refValue: 45,
      });
    }

    // 5. Gasto de pauta vs margen — verde ≤45, amarillo ≤60, rojo >60.
    //    Solo si hay pauta Y utilidad > 0; si no, gris.
    {
      if (pautaTotal > 0 && f.utilidad_bruta > 0) {
        const v = (pautaTotal / f.utilidad_bruta) * 100;
        const color = evalIndicator(v, 'menor', 45, 60);
        list.push({
          label: 'Pauta vs margen',
          display: pct(v),
          color,
          ref: 'Ref: ≤45%',
          hint: 'Cuánto del margen se come la pauta.',
          icon: Megaphone,
          raw: isFinite(v) ? v : null,
          refValue: 45,
        });
      } else {
        list.push({
          label: 'Pauta vs margen',
          display: '—',
          color: 'gray',
          ref: 'Ref: ≤45%',
          hint: 'Registrá tu pauta para ver esto.',
          icon: Megaphone,
          raw: null,
          refValue: 45,
        });
      }
    }

    // 6. Retorno de la pauta (utilidad ÷ pauta, como múltiplo) — MAYOR es
    //    mejor. Verde ≥2×, amarillo ≥1.2×, rojo <1.2×. Solo si hay pauta.
    {
      if (pautaTotal > 0) {
        const v = f.utilidad_bruta / pautaTotal;
        const color = evalIndicator(v, 'mayor', 2, 1.2);
        list.push({
          label: 'Retorno de la pauta',
          display: `${v.toFixed(1)}×`,
          color,
          ref: 'Ref: ≥2×',
          hint: 'Utilidad bruta por cada $1 de pauta.',
          icon: Coins,
          raw: isFinite(v) ? v : null,
          refValue: 2,
        });
      } else {
        list.push({
          label: 'Retorno de la pauta',
          display: '—',
          color: 'gray',
          ref: 'Ref: ≥2×',
          hint: 'Registrá tu pauta para ver esto.',
          icon: Coins,
          raw: null,
          refValue: 2,
        });
      }
    }

    return list;
  }, [finQuery.data, pautaTotal]);

  return (
    <div className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d hairline-top">
      <header className="flex items-center gap-2 mb-1">
        <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center shrink-0" aria-hidden="true">
          <Activity size={17} />
        </span>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          Semáforo de salud financiera
        </h3>
      </header>
      <p className="text-xs text-muted-foreground mb-4">
        Qué tan sano está el negocio en este período, contra los estándares del mercado.
      </p>

      {finQuery.isLoading ? (
        // Skeleton con rounded-2xl = el MISMO radio que la celda real (Cell).
        // Si los dos radios divergen, las 6 cajas cambian de forma al terminar
        // de cargar: un salto visual, justo lo que la regla de arriba pide
        // evitar. La ALTURA también va emparejada con la celda real (que creció
        // al sumar chip de ícono + barra de referencia): si el esqueleto es más
        // bajo, la grilla salta hacia abajo al llegar los datos.
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border bg-muted/30 h-[196px]"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : finQuery.isError || !indicators ? (
        // bg-muted/20, no bg-card/40: el contenedor padre (línea 195) ya es
        // bg-card/40 y el mensaje quedaba sin contraste contra su fondo.
        <div className="rounded-2xl border border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          Sin datos financieros en este período.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {indicators.map((ind) => (
              <Cell key={ind.label} ind={ind} />
            ))}
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground leading-snug">
            Referencias tomadas de estándares de e-commerce COD (costo ≤38%, flete ≤20%,
            devoluciones ≤3%, margen ≥45%).
          </p>
        </>
      )}
    </div>
  );
}
