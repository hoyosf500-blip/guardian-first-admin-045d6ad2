import { memo, type ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus, GitCompare, Package, CheckCircle2, RotateCcw, Truck as TruckIcon, AlertTriangle } from 'lucide-react';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import DateRangeFilter from '@/components/logistics/DateRangeFilter';
import { formatCOP } from '@/lib/utils';
import { deriveDeliveryMaturity, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from '@/lib/logisticsRates';
import type { LogisticsFilters, LogisticsSummary } from '@/lib/logistics.types';

// Tasa MADURA (÷ entregados+devueltos) desde los conteos del summary. Antes esta
// vista usaba summary.tasa_entrega/tasa_devolucion CRUDAS (÷ total, con
// pendientes/tránsito en el denominador), así que el período en curso (inmaduro,
// medio cohorte en camino) siempre parecía "empeorar" vs un período pasado ya
// concluido. Era el único de los 7 componentes de /logística sin madurez.
//
// HONESTIDAD: `tasaEntregaMadura` es null A PROPÓSITO cuando no hay pedidos
// concluidos (entregados+devueltos = 0) — quiere decir "no hay con qué medir".
// Antes se aplastaba con `?? 0`, así que un período recién arrancado (todo en
// tránsito) se mostraba como "0.0% de entrega" y disparaba el veredicto rojo
// "Empeoramiento" sobre algo que nadie midió. Ahora el null se propaga hasta el
// render y la pantalla muestra "—".
interface Maduras {
  entrega: number | null;
  devolucion: number | null;
  /** Cohorte inmaduro o muestra chica → la tasa NO es concluyente (gris + "prelim."). */
  prelim: boolean;
  resueltos: number;
}
function maduras(s: LogisticsSummary | null): Maduras {
  if (!s) return { entrega: null, devolucion: null, prelim: false, resueltos: 0 };
  const m = deriveDeliveryMaturity(s.entregados ?? 0, s.devueltos ?? 0, s.total_pedidos ?? 0, s.rechazados ?? 0);
  return {
    entrega: m.tasaEntregaMadura,
    devolucion: m.tasaDevolucionMadura,
    prelim: isRatePreliminary(m),
    resueltos: m.resueltos,
  };
}

/** "62.0%" · "62.0% · prelim." · "—" cuando no hay nada concluido. */
function fmtTasa(v: number | null, prelim: boolean): string {
  if (v == null) return '—';
  return `${v.toFixed(1)}%${prelim ? ' · prelim.' : ''}`;
}

const SIN_CONCLUIDOS_HINT =
  'Sin pedidos concluidos (entregados o devueltos) en este período: todavía no hay con qué calcular la tasa. No es 0%.';

interface Props {
  periodA: LogisticsFilters;
  periodB: LogisticsFilters;
  onPeriodAChange: (range: LogisticsFilters) => void;
  onPeriodBChange: (range: LogisticsFilters) => void;
}

/**
 * Vista comparativa A vs B. Carga 2 summaries en paralelo y muestra los KPIs
 * principales lado a lado con delta (Δ%) entre períodos. Ideal para validar
 * "antes vs después" cuando el admin hace cambios operativos.
 */
export default memo(function ComparisonView({
  periodA, periodB,
  onPeriodAChange, onPeriodBChange,
}: Props) {
  const a = useLogisticsStats(periodA);
  const b = useLogisticsStats(periodB);

  const aError = a.summary.isError;
  const bError = b.summary.isError;

  // Esta vista consume SOLO `summary`; los otros 3 queries del hook (carriers /
  // cities / products) no se renderizan acá. Por eso miramos el estado de
  // `summary` y no el `isLoading`/`isError` agregado del hook: si
  // `logistics_by_product` tarda o se cae, no tiene por qué dejar en "cargando"
  // una columna cuyo summary YA llegó, ni tapar la comparación.
  //
  // react-query v5: `isPending` = todavía no hay resultado (incluye la query
  // DESHABILITADA mientras StoreContext resuelve la tienda). No es lo mismo que
  // "la base respondió y vino vacío" — ese caso es isSuccess con data null.
  const aPending = a.summary.isPending;
  const bPending = b.summary.isPending;

  // Un período solo sirve como base de comparación cuando YA se leyó de verdad.
  // Antes cada columna solo miraba SU propio isLoading: la que terminaba primero
  // se comparaba contra `compareTo = null` → ceros de relleno → flechas verdes
  // "+62.0 pts" contra un período que la base todavía no había devuelto.
  const aReady = a.summary.isSuccess && !!a.summary.data;
  const bReady = b.summary.isSuccess && !!b.summary.data;

  return (
    <div className="space-y-4">
      {(aError || bError) && (
        // Banner del lenguaje: barra lateral w-1 + chip de 36px con glow.
        <div className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-danger/20 glow-danger">
            <AlertTriangle size={17} className="text-danger" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-danger">
              {aError && bError
                ? 'No pudimos cargar ninguno de los dos períodos'
                : `No pudimos cargar el período ${aError ? 'A' : 'B'}`}
            </div>
            {/* La ADVERTENCIA va en prosa legible, no en mono de 10px: es lo que
                evita que alguien decida con una pantalla rota. El detalle
                técnico (el mensaje del error) sí es dato y va en mono aparte. */}
            <div className="text-xs text-foreground/90 mt-1 leading-relaxed">
              No hay comparación válida: no tomes decisiones con esta pantalla hasta que cargue.
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 font-mono tabular-nums leading-relaxed">
              {(a.summary.error as Error)?.message ?? (b.summary.error as Error)?.message ?? 'Error desconocido'}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PeriodHeader label="Período A" accent="info"   range={periodA} onChange={onPeriodAChange} />
        <PeriodHeader label="Período B" accent="accent" range={periodB} onChange={onPeriodBChange} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PeriodColumn
          label="Período A"
          accent="info"
          summary={a.summary.data ?? null}
          isPending={aPending}
          isError={aError}
          compareTo={b.summary.data ?? null}
          compareReady={bReady}
        />
        <PeriodColumn
          label="Período B"
          accent="accent"
          summary={b.summary.data ?? null}
          isPending={bPending}
          isError={bError}
          compareTo={a.summary.data ?? null}
          compareReady={aReady}
        />
      </div>

      {aReady && bReady && a.summary.data && b.summary.data && (
        <DeltaSummary periodA={a.summary.data} periodB={b.summary.data} />
      )}
    </div>
  );
});

// ── Sub-componentes ─────────────────────────────────────────────

function PeriodHeader({
  label, accent, range, onChange,
}: {
  label: string;
  accent: 'info' | 'accent';
  range: LogisticsFilters;
  onChange: (range: LogisticsFilters) => void;
}) {
  const accentClass = accent === 'info'
    ? 'bg-info/14 border-info/30 text-info'
    : 'bg-accent/14 border-accent/30 text-accent';
  const days = Math.round(
    (new Date(range.toDate).getTime() - new Date(range.fromDate).getTime()) / (24 * 3600 * 1000),
  );
  return (
    <div className="rounded-2xl border border-border bg-card/40 p-3 shadow-card3d hairline-top space-y-2">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold ${accentClass}`}>
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
          {days} día{days !== 1 ? 's' : ''}
        </span>
      </div>
      <DateRangeFilter value={range} onChange={onChange} />
    </div>
  );
}

/** Columna sin KPIs: la consulta falló (danger) o respondió vacía (muted).
 *  Mantiene el encabezado del período para que no se pierda cuál es cuál. */
function NoticeCard({
  label, accentBorder, tone, children,
}: {
  label: string;
  accentBorder: string;
  tone: 'danger' | 'muted';
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border ${accentBorder} bg-card/40 overflow-hidden shadow-card3d hairline-top`}>
      <header className="px-5 py-3.5 border-b border-border/60">
        <h3 className="hud-label">{label}</h3>
      </header>
      <div className="p-5 flex items-start gap-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
          tone === 'danger' ? 'bg-danger/20 glow-danger' : 'bg-muted/60 border border-border'
        }`}>
          <AlertTriangle
            size={17}
            className={tone === 'danger' ? 'text-danger' : 'text-muted-foreground'}
            aria-hidden="true"
          />
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

interface PeriodColumnProps {
  label: string;
  accent: 'info' | 'accent';
  summary: LogisticsSummary | null;
  /** La consulta todavía no devolvió resultado (o está deshabilitada esperando tienda). */
  isPending: boolean;
  isError: boolean;
  compareTo: LogisticsSummary | null;
  /** false mientras el OTRO período carga o falla → no se dibuja ningún delta. */
  compareReady: boolean;
}
function PeriodColumn({ label, accent, summary, isPending, isError, compareTo, compareReady }: PeriodColumnProps) {
  const accentBorder = accent === 'info' ? 'border-info/40' : 'border-accent/40';

  // ORDEN IMPORTA: primero el error (en v5 un query con error ya NO está
  // pending, así que nunca queda escondido detrás del shimmer), después el
  // "todavía no hay respuesta" (shimmer honesto), y recién al final el
  // "respondió y vino vacío". Fusionarlos haría que una consulta que jamás
  // corrió se anunciara como "Sin datos", que es afirmar algo que no sabemos.
  if (isError) {
    return (
      <NoticeCard label={label} accentBorder={accentBorder} tone="danger">
        No pudimos leer los datos de este período. Los KPIs no se muestran para no inventar cifras.
      </NoticeCard>
    );
  }

  if (isPending) {
    return (
      <div className={`rounded-2xl border ${accentBorder} bg-card/40 p-5 shadow-card3d hairline-top skeleton-shimmer min-h-[400px]`} />
    );
  }

  if (!summary) {
    return (
      <NoticeCard label={label} accentBorder={accentBorder} tone="muted">
        Sin datos para este período.
      </NoticeCard>
    );
  }

  const total = summary.total_pedidos ?? 0;
  const entregados = summary.entregados ?? 0;
  const devueltos = summary.devueltos ?? 0;
  const enTransito = summary.en_transito ?? 0;
  // Tasas MADURAS (÷ concluidos), no las crudas del RPC, para no comparar
  // manzanas (período inmaduro) con peras (período concluido).
  const mThis = maduras(summary);
  // `cmp` es null mientras el otro período no esté leído → todos los rawCompare
  // quedan en null y KpiLine no dibuja delta (en vez de comparar contra 0).
  const cmp = compareReady ? compareTo : null;
  const mCompare = maduras(cmp);
  const valorEntregado = summary.valor_entregado ?? 0;
  // Muestra chica / cohorte inmaduro en CUALQUIERA de los dos lados: se muestra
  // el número pero sin veredicto verde/rojo (con 1-4 concluidos la tasa salta a
  // 0%/100% por puro ruido).
  const tasaPrelim = mThis.prelim || mCompare.prelim;
  const prelimHint = `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos o cohorte todavía en tránsito — la tasa aún no es confiable.`;

  return (
    <div className={`rounded-2xl border ${accentBorder} bg-card/40 overflow-hidden shadow-card3d hairline-top`}>
      <header className="px-5 py-3.5 border-b border-border/60">
        <h3 className="hud-label">{label}</h3>
      </header>
      <div className="p-5 space-y-1">
        <KpiLine icon={Package}      label="Total pedidos" value={total.toLocaleString('es-CO')}      rawValue={total}      rawCompare={cmp ? (cmp.total_pedidos ?? 0) : null} format="absolute" />
        <KpiLine icon={CheckCircle2} label="Entregados"    value={entregados.toLocaleString('es-CO')} rawValue={entregados} rawCompare={cmp ? (cmp.entregados ?? 0) : null}    format="absolute" tone="success" />
        <KpiLine icon={RotateCcw}    label="Devueltos"     value={devueltos.toLocaleString('es-CO')}  rawValue={devueltos}  rawCompare={cmp ? (cmp.devueltos ?? 0) : null}     format="absolute" tone="danger" inverseDelta />
        <KpiLine icon={TruckIcon}    label="En tránsito"   value={enTransito.toLocaleString('es-CO')} rawValue={enTransito} rawCompare={cmp ? (cmp.en_transito ?? 0) : null}   format="absolute" />

        <div className="pt-2 mt-2 border-t border-border/60 space-y-1">
          <KpiLine
            label="Tasa de entrega"
            value={fmtTasa(mThis.entrega, mThis.prelim)}
            rawValue={mThis.entrega}
            rawCompare={mCompare.entrega}
            format="points"
            tone={mThis.entrega == null || mThis.prelim ? 'muted' : 'success'}
            neutralDelta={tasaPrelim}
            hint={mThis.entrega == null ? SIN_CONCLUIDOS_HINT : mThis.prelim ? prelimHint : undefined}
          />
          <KpiLine
            label="Tasa de devolución"
            value={fmtTasa(mThis.devolucion, mThis.prelim)}
            rawValue={mThis.devolucion}
            rawCompare={mCompare.devolucion}
            format="points"
            tone={mThis.devolucion == null || mThis.prelim ? 'muted' : 'danger'}
            inverseDelta
            neutralDelta={tasaPrelim}
            hint={mThis.devolucion == null ? SIN_CONCLUIDOS_HINT : mThis.prelim ? prelimHint : undefined}
          />
          <KpiLine label="Valor entregado"     value={formatCOP(valorEntregado)}       rawValue={valorEntregado}  rawCompare={cmp ? (cmp.valor_entregado ?? 0) : null} format="absolute" tone="success" />
        </div>
      </div>
    </div>
  );
}

interface KpiLineProps {
  icon?: typeof Package;
  label: string;
  value: string;
  /** null = no hay dato medido (no es 0) → no se dibuja delta. */
  rawValue: number | null;
  /** null = el otro período no está leído o no tiene nada concluido. */
  rawCompare: number | null;
  format: 'absolute' | 'points';
  tone?: 'success' | 'danger' | 'muted';
  inverseDelta?: boolean;
  /** Hay número pero la muestra es preliminar → delta en gris, sin veredicto. */
  neutralDelta?: boolean;
  /** Tooltip que explica por qué el valor es "—" o por qué es preliminar. */
  hint?: string;
}
function KpiLine({ icon: Icon, label, value, rawValue, rawCompare, format, tone, inverseDelta, neutralDelta, hint }: KpiLineProps) {
  const valueClass = tone === 'success' ? 'text-success'
    : tone === 'danger' ? 'text-danger'
    : tone === 'muted' ? 'text-muted-foreground'
    : 'text-foreground';

  // Sin dato en CUALQUIERA de los dos lados no hay comparación posible: se omite
  // el delta. Antes el lado faltante llegaba como 0 y la fila afirmaba
  // "+62.0 pts" contra un período que nadie había medido.
  let delta: number | null = null;
  let deltaLabel = '';
  if (rawValue != null && rawCompare != null && (rawCompare > 0 || rawValue > 0)) {
    if (format === 'absolute') {
      if (rawCompare > 0) {
        delta = ((rawValue - rawCompare) / rawCompare) * 100;
        deltaLabel = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
      } else if (rawValue > 0) {
        delta = 100;
        deltaLabel = '+∞';
      }
    } else {
      delta = rawValue - rawCompare;
      deltaLabel = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts`;
    }
  }

  let deltaTone: 'success' | 'danger' | 'neutral';
  if (delta === null || Math.abs(delta) < 0.05 || neutralDelta) {
    deltaTone = 'neutral';
  } else {
    const isUp = delta > 0;
    const isGood = inverseDelta ? !isUp : isUp;
    deltaTone = isGood ? 'success' : 'danger';
  }

  // Píldora de delta con la MISMA forma que el TrendBadge del Dashboard
  // (rounded-lg, fondo /14, borde /30) para que "subió/bajó" se lea igual en las
  // dos pantallas. El gris neutro se conserva para el caso preliminar.
  const deltaChipClass =
    deltaTone === 'success' ? 'bg-success/14 border-success/30 text-success' :
    deltaTone === 'danger' ? 'bg-danger/14 border-danger/30 text-danger' :
    'bg-muted/50 border-border text-muted-foreground';

  const DeltaIcon = delta === null ? null
    : Math.abs(delta) < 0.05 ? Minus
    : delta > 0 ? TrendingUp : TrendingDown;

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-xl px-2 py-1.5 -mx-2 hover:bg-card/60 transition-colors duration-200"
      title={hint}
    >
      <div className="flex items-center gap-2 min-w-0">
        {Icon && (
          <span className="w-7 h-7 rounded-lg bg-muted/60 border border-border text-muted-foreground flex items-center justify-center flex-shrink-0">
            <Icon size={13} aria-hidden="true" />
          </span>
        )}
        <span className="text-xs text-muted-foreground truncate">{label}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`font-mono font-bold tabular-nums text-sm ${valueClass}`}>{value}</span>
        {delta !== null && DeltaIcon && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[10px] font-semibold whitespace-nowrap ${deltaChipClass}`}>
            <DeltaIcon size={10} aria-hidden="true" />
            <span className="font-mono tabular-nums">{deltaLabel}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function DeltaSummary({ periodA, periodB }: { periodA: LogisticsSummary; periodB: LogisticsSummary }) {
  // Tasas MADURAS (÷ concluidos) para el resumen del delta también.
  const mA = maduras(periodA);
  const mB = maduras(periodB);

  // Si algún período no tiene NADA concluido, no hay tasa que comparar. Antes el
  // `?? 0` la volvía 0.0% y esta card dictaminaba "Empeoramiento: tasa de entrega
  // cayó" con "62.0% → 0.0% (-62.0 pts)" sobre un período que nadie midió.
  if (mA.entrega == null || mB.entrega == null || mA.devolucion == null || mB.devolucion == null) {
    const cual = mA.entrega == null && mB.entrega == null
      ? 'Ninguno de los dos períodos tiene'
      : mA.entrega == null ? 'El período A todavía no tiene' : 'El período B todavía no tiene';
    return (
      <div className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-border bg-muted/20 px-4 pl-5 py-3 shadow-card3d">
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-muted-foreground/40" aria-hidden="true" />
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-muted/60 border border-border">
          <GitCompare size={17} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-muted-foreground">Sin datos concluidos para comparar</div>
          <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            {cual} pedidos entregados ni devueltos, así que no hay tasa de entrega que comparar. No es 0%: es que todavía no concluyó nada.
          </div>
        </div>
      </div>
    );
  }

  const tasaA = mA.entrega;
  const tasaB = mB.entrega;
  const deltaTasa = tasaB - tasaA;

  const devA = mA.devolucion;
  const devB = mB.devolucion;
  const deltaDev = devB - devA;

  // Muestra chica o cohorte a medio camino: se muestran los números pero SIN
  // veredicto (con 1-4 concluidos la tasa salta a 0%/100% por ruido).
  const prelim = mA.prelim || mB.prelim;

  const isPositive = deltaTasa > 0 && deltaDev <= 0;
  const baseTone = Math.abs(deltaTasa) < 1 && Math.abs(deltaDev) < 1
    ? 'neutral'
    : isPositive ? 'success' : (deltaTasa < -3 || deltaDev > 3) ? 'danger' : 'warning';
  const tone = prelim ? 'neutral' : baseTone;

  const headline = (() => {
    if (prelim) return `Comparación preliminar: alguno de los períodos tiene menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos o sigue mayormente en tránsito. Todavía no hay veredicto.`;
    if (tone === 'neutral') return 'Sin cambios significativos entre los períodos.';
    if (tone === 'success') return 'Mejora operativa: la tasa de entrega subió y/o devoluciones bajaron.';
    if (tone === 'warning') return 'Cambios mixtos. Revisar detalle.';
    return 'Empeoramiento: tasa de entrega cayó y/o devoluciones subieron.';
  })();

  // Banner del lenguaje: barra lateral de color pleno + chip de 36px con glow +
  // la línea de metadatos en font-mono. El veredicto sigue siendo TEXTO: esto es
  // un delta con signo, no un 0-100, así que no lleva aro ni barra.
  const toneStyles = {
    success: { bg: 'bg-success/10', border: 'border-success/30', text: 'text-success', bar: 'bg-success', chip: 'bg-success/20 glow-success' },
    warning: { bg: 'bg-warning/10', border: 'border-warning/30', text: 'text-warning', bar: 'bg-warning', chip: 'bg-warning/20 glow-warning' },
    danger:  { bg: 'bg-danger/10',  border: 'border-danger/30',  text: 'text-danger',  bar: 'bg-danger',  chip: 'bg-danger/20 glow-danger' },
    neutral: { bg: 'bg-muted/20',   border: 'border-border',     text: 'text-muted-foreground', bar: 'bg-muted-foreground/40', chip: 'bg-muted/60 border border-border' },
  }[tone];

  return (
    <div className={`relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border ${toneStyles.border} ${toneStyles.bg} px-4 pl-5 py-3 shadow-card3d`}>
      <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${toneStyles.bar}`} aria-hidden="true" />
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${toneStyles.chip}`}>
        <GitCompare size={17} className={toneStyles.text} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-xs font-semibold ${toneStyles.text}`}>{headline}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5 font-mono tabular-nums leading-relaxed">
          Tasa de entrega: <span className="font-mono">{tasaA.toFixed(1)}% → {tasaB.toFixed(1)}%</span> ({deltaTasa > 0 ? '+' : ''}{deltaTasa.toFixed(1)} pts) ·
          {' '}Devolución: <span className="font-mono">{devA.toFixed(1)}% → {devB.toFixed(1)}%</span> ({deltaDev > 0 ? '+' : ''}{deltaDev.toFixed(1)} pts)
          {prelim && (
            <> · <span className="font-semibold">prelim.</span> ({mA.resueltos} y {mB.resueltos} pedidos concluidos)</>
          )}
        </div>
      </div>
    </div>
  );
}
