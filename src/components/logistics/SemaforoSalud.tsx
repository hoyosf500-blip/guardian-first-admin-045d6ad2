import { useMemo } from 'react';
import { Activity } from 'lucide-react';
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

// ── Chip por color ─ reusa las utility classes del DS (index.css) ──
const CHIP_CLASS: Record<HealthColor, string> = {
  green:  'pill pill-success',
  yellow: 'pill pill-warning',
  red:    'pill pill-danger',
  gray:   'pill pill-neutral',
};

// Valor grande coloreado por estado (más legible que solo el chip).
const VALUE_CLASS: Record<HealthColor, string> = {
  green:  'text-success',
  yellow: 'text-warning',
  red:    'text-danger',
  gray:   'text-muted-foreground',
};

interface Indicator {
  label: string;
  /** Valor ya formateado para mostrar (ej "38.0%", "2.3×"). */
  display: string;
  color: HealthColor;
  /** Texto de referencia del estándar, ej "Ref: ≤38%". */
  ref: string;
  /** Micro-frase de contexto/veredicto extendido. */
  hint: string;
}

function pct(n: number): string {
  if (!isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

/** Celda individual del semáforo. Estática, sin animaciones. */
function Cell({ ind }: { ind: Indicator }) {
  return (
    <div className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d hairline-top flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold text-foreground leading-tight">
          {ind.label}
        </span>
        <span className={`${CHIP_CLASS[ind.color]} shrink-0 whitespace-nowrap`}>
          {veredictoLabel(ind.color)}
        </span>
      </div>
      <div className={`text-2xl font-bold font-mono tabular-nums leading-none ${VALUE_CLASS[ind.color]}`}>
        {ind.display}
      </div>
      <div className="text-[11px] text-muted-foreground font-mono tabular-nums">{ind.ref}</div>
      <div className="text-[11px] text-muted-foreground leading-snug">{ind.hint}</div>
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
        });
      } else {
        list.push({
          label: 'Pauta vs margen',
          display: '—',
          color: 'gray',
          ref: 'Ref: ≤45%',
          hint: 'Registrá tu pauta para ver esto.',
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
        });
      } else {
        list.push({
          label: 'Retorno de la pauta',
          display: '—',
          color: 'gray',
          ref: 'Ref: ≥2×',
          hint: 'Registrá tu pauta para ver esto.',
        });
      }
    }

    return list;
  }, [finQuery.data, pautaTotal]);

  return (
    <div className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d hairline-top">
      <header className="flex items-center gap-2 mb-1">
        <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center shrink-0" aria-hidden="true">
          <Activity size={15} />
        </span>
        <h3 className="text-sm font-bold tracking-tight text-foreground">
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
        // evitar. Al pasar la celda al radio de tarjeta del DS, el skeleton la
        // sigue.
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border bg-muted/30 h-[112px]"
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
