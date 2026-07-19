import { useMemo, useState } from 'react';
import {
  Wallet, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus,
  Briefcase, User, AlertTriangle, Loader2, RefreshCw,
} from 'lucide-react';
import {
  usePersonalSpendingByMonth, usePersonalSpendingTopItems,
  useRecategorizePersonalMovements,
  CATEGORIA_LABELS, type Categoria, type SpendingByMonthRow,
} from '@/hooks/usePersonalCardMovements';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from 'recharts';
import {
  CHART_TOOLTIP_STYLE, CHART_GRID_PROPS, CHART_BAR_CURSOR, fmtCompact,
} from '@/components/logistics/charts/chartTokens';
import {
  BarGradientDefs, SwatchLegend, GradientBar,
} from './cfoVisuals';
import {
  barGlow, CHART_INFO, CHART_WARNING, CHART_DANGER, CHART_SUCCESS, CHART_MUTED,
} from './cfoChartTokens';

// Tracker de gasto personal por categoría × mes. Lee personal_spending_by_month
// y agrega top-items drill-down al expandir una fila.

const CATEGORIA_TONE: Record<Categoria, 'danger' | 'warning' | 'success' | 'muted'> = {
  pauta_facebook:     'warning',
  pauta_tiktok:       'success',
  educacion:          'success',
  software_negocio:   'success',
  comision_avance:    'danger',
  avance_efectivo:    'danger',
  intereses:          'danger',
  abono_pago:         'muted',
  comida_delivery:    'warning',
  comida_restaurante: 'warning',
  mercado:            'muted',
  salud:              'muted',
  compras_personales: 'warning',
  viajes:             'muted',
  suscripciones:      'muted',
  compras_online:     'muted',
  transporte:         'muted',
  otro:               'muted',
};

const TONE_TEXT: Record<string, string> = {
  danger:  'text-danger',
  warning: 'text-warning',
  success: 'text-success',
  muted:   'text-foreground',
};

/** Mismo tono, en color de dibujo (token HSL) para barras y gráficos. */
const TONE_STROKE: Record<string, string> = {
  danger:  CHART_DANGER,
  warning: CHART_WARNING,
  success: CHART_SUCCESS,
  muted:   CHART_MUTED,
};

// Toggle de vista estilo pill (presentación). El estado sigue siendo `view`.
const PILL_ON =
  'h-auto px-4 py-2 rounded-xl text-sm font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d hover:bg-accent/20';
const PILL_OFF =
  'h-auto px-4 py-2 rounded-xl text-sm font-medium bg-card/40 border border-border text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors';

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('es-CO', { month: 'short', year: '2-digit' });
}

function deltaIcon(curr: number, prev: number) {
  if (prev === 0 && curr === 0) return { Icon: Minus, tone: 'text-muted-foreground' };
  if (prev === 0) return { Icon: TrendingUp, tone: 'text-warning' };
  const delta = ((curr - prev) / Math.abs(prev)) * 100;
  if (Math.abs(delta) < 1) return { Icon: Minus, tone: 'text-muted-foreground' };
  return delta > 0
    ? { Icon: TrendingUp, tone: 'text-danger' }
    : { Icon: TrendingDown, tone: 'text-success' };
}

type ViewMode = 'matrix' | 'split' | 'topitems';

export default function CfoPersonalSpendingTracker() {
  const [view, setView] = useState<ViewMode>('matrix');
  const [selectedMonth, setSelectedMonth] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: rows = [], isLoading } = usePersonalSpendingByMonth();
  const recategorize = useRecategorizePersonalMovements();

  const { months, categorias, matrix, totalsByMonth, totalsByCat, businessByMonth, personalByMonth } = useMemo(() => {
    const monthSet = new Set<string>();
    const catSet = new Set<Categoria>();
    rows.forEach(r => {
      monthSet.add(r.year_month);
      catSet.add(r.categoria);
    });
    const months = Array.from(monthSet).sort().reverse();
    const categorias = Array.from(catSet);

    const matrix = new Map<string, number>();
    const totalsByMonth = new Map<string, number>();
    const totalsByCat = new Map<Categoria, number>();
    const businessByMonth = new Map<string, number>();
    const personalByMonth = new Map<string, number>();

    rows.forEach(r => {
      const k = `${r.categoria}|${r.year_month}`;
      matrix.set(k, (matrix.get(k) ?? 0) + r.monto_cop);
      totalsByMonth.set(r.year_month, (totalsByMonth.get(r.year_month) ?? 0) + r.monto_cop);
      totalsByCat.set(r.categoria, (totalsByCat.get(r.categoria) ?? 0) + r.monto_cop);
      if (r.es_negocio) {
        businessByMonth.set(r.year_month, (businessByMonth.get(r.year_month) ?? 0) + r.monto_cop);
      } else {
        personalByMonth.set(r.year_month, (personalByMonth.get(r.year_month) ?? 0) + r.monto_cop);
      }
    });

    categorias.sort((a, b) => (totalsByCat.get(b) ?? 0) - (totalsByCat.get(a) ?? 0));

    return { months, categorias, matrix, totalsByMonth, totalsByCat, businessByMonth, personalByMonth };
  }, [rows]);

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-6 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Cargando movimientos…</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
        Aún no hay movimientos importados. Subí extractos PDF arriba para empezar.
      </div>
    );
  }

  const monthForTopItems = selectedMonth || months[0] || '';

  return (
    <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top p-5">
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 shrink-0 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center">
            <Wallet size={17} aria-hidden="true" />
          </span>
          <h3 className="font-semibold text-sm">Análisis tarjetas (gasto personal)</h3>
        </div>
        <div className="inline-flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={view === 'matrix' ? 'default' : 'outline'}
            onClick={() => setView('matrix')}
            className={view === 'matrix' ? PILL_ON : PILL_OFF}
          >
            Por categoría
          </Button>
          <Button
            size="sm"
            variant={view === 'split' ? 'default' : 'outline'}
            onClick={() => setView('split')}
            className={view === 'split' ? PILL_ON : PILL_OFF}
          >
            Negocio vs personal
          </Button>
          <Button
            size="sm"
            variant={view === 'topitems' ? 'default' : 'outline'}
            onClick={() => setView('topitems')}
            className={view === 'topitems' ? PILL_ON : PILL_OFF}
          >
            Top items
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                const r = await recategorize.mutateAsync();
                toast.success(`Re-categorizados ${r.updated} movimientos`);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Error');
              }
            }}
            className="h-7 text-xs"
            title="Re-aplicar reglas de categorización a movimientos viejos"
          >
            <RefreshCw size={12} className={recategorize.isPending ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {view === 'matrix' && (
        <MatrixView
          months={months}
          categorias={categorias}
          matrix={matrix}
          totalsByMonth={totalsByMonth}
          totalsByCat={totalsByCat}
          rows={rows}
          expanded={expanded}
          setExpanded={setExpanded}
          onSelectMonth={(m) => { setSelectedMonth(m); setView('topitems'); }}
        />
      )}

      {view === 'split' && (
        <SplitView
          months={months}
          businessByMonth={businessByMonth}
          personalByMonth={personalByMonth}
        />
      )}

      {view === 'topitems' && monthForTopItems && (
        <TopItemsView
          yearMonth={monthForTopItems}
          months={months}
          onChangeMonth={setSelectedMonth}
        />
      )}
    </div>
  );
}

// ─── Matrix view ────────────────────────────────────────────────────

interface MatrixViewProps {
  months: string[];
  categorias: Categoria[];
  matrix: Map<string, number>;
  totalsByMonth: Map<string, number>;
  totalsByCat: Map<Categoria, number>;
  rows: SpendingByMonthRow[];
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  onSelectMonth: (ym: string) => void;
}

function MatrixView({ months, categorias, matrix, totalsByMonth, totalsByCat, rows, expanded, setExpanded, onSelectMonth }: MatrixViewProps) {
  const toggle = (cat: Categoria) => {
    const next = new Set(expanded);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    setExpanded(next);
  };

  const negocioByCat = useMemo(() => {
    const m = new Map<Categoria, boolean>();
    rows.forEach(r => { if (r.es_negocio) m.set(r.categoria, true); });
    return m;
  }, [rows]);

  // Denominador de la barra de participación. Es la MISMA suma que ya se
  // imprime en la esquina inferior derecha de la tabla, no un total nuevo.
  const grandTotal = useMemo(
    () => Array.from(totalsByCat.values()).reduce((a, b) => a + b, 0),
    [totalsByCat],
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="text-left hud-label px-2 py-2 sticky left-0 bg-card">Categoría</th>
            {months.map(m => (
              <th key={m} className="text-right font-medium px-2 py-2 whitespace-nowrap">
                <button
                  onClick={() => onSelectMonth(m)}
                  className="font-mono tabular-nums hover:text-accent transition-colors duration-200"
                >
                  {fmtMonth(m)}
                </button>
              </th>
            ))}
            <th className="text-right hud-label px-2 py-2 bg-muted/40">Total</th>
          </tr>
        </thead>
        <tbody>
          {categorias.map(cat => {
            const tone = CATEGORIA_TONE[cat] ?? 'muted';
            const isNegocio = negocioByCat.get(cat) ?? false;
            const isExpanded = expanded.has(cat);
            const catTotal = totalsByCat.get(cat) ?? 0;
            const share = grandTotal > 0 ? (catTotal / grandTotal) * 100 : 0;
            return (
              <tr key={cat} className="border-t border-border/50 hover:bg-foreground/[0.035] transition-colors duration-200">
                <td className={`px-2 py-2 sticky left-0 bg-card ${TONE_TEXT[tone]}`}>
                  <button
                    onClick={() => toggle(cat)}
                    className="flex items-center gap-1 hover:underline text-left"
                  >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {isNegocio ? <Briefcase size={11} className="text-info" /> : <User size={11} />}
                    <span>{CATEGORIA_LABELS[cat] ?? cat}</span>
                  </button>
                </td>
                {months.map(m => {
                  const v = matrix.get(`${cat}|${m}`) ?? 0;
                  return (
                    <td key={m} className="text-right px-2 py-2 font-mono tabular-nums">
                      {v > 0 ? formatCOP(v) : <span className="text-muted-foreground">—</span>}
                    </td>
                  );
                })}
                {/* La barra dibuja la participación de la categoría en el total
                    ya impreso abajo: qué se come la plata se ve sin comparar
                    números a ojo. */}
                <td className="text-right px-2 py-2 font-semibold bg-muted/40 font-mono tabular-nums min-w-[120px]">
                  {formatCOP(catTotal)}
                  <GradientBar
                    pct={share}
                    color={TONE_STROKE[tone] ?? CHART_MUTED}
                    height={4}
                    className="mt-1.5"
                  />
                </td>
              </tr>
            );
          })}
          <tr className="border-t-2 border-border bg-muted/30 font-semibold">
            <td className="px-2 py-2.5 sticky left-0 bg-muted/30">Total mes</td>
            {months.map(m => (
              <td key={m} className="text-right px-2 py-2.5 font-mono tabular-nums">
                {formatCOP(totalsByMonth.get(m) ?? 0)}
              </td>
            ))}
            <td className="text-right px-2 py-2.5 font-mono tabular-nums">
              {formatCOP(Array.from(totalsByMonth.values()).reduce((a, b) => a + b, 0))}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Split view: negocio vs personal ──────────────────────────────────

interface SplitViewProps {
  months: string[];
  businessByMonth: Map<string, number>;
  personalByMonth: Map<string, number>;
}

function SplitView({ months, businessByMonth, personalByMonth }: SplitViewProps) {
  // Misma partición de la tabla (negocio vs personal por mes), en orden
  // ascendente para que el eje temporal se lea de izquierda a derecha.
  const chartData = useMemo(
    () => [...months].reverse().map(m => ({
      mes: m,
      negocio:  businessByMonth.get(m) ?? 0,
      personal: personalByMonth.get(m) ?? 0,
    })),
    [months, businessByMonth, personalByMonth],
  );

  return (
    <div className="overflow-x-auto">
      {chartData.length > 0 && (
        <div className="mb-4">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
            <h4 className="text-xs font-semibold text-foreground">Gasto por mes</h4>
            <SwatchLegend
              items={[
                { color: CHART_INFO,    label: 'Negocio' },
                { color: CHART_WARNING, label: 'Personal' },
              ]}
            />
          </div>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
                <BarGradientDefs
                  prefix="splitGasto"
                  entries={[
                    { key: 'negocio',  color: CHART_INFO },
                    { key: 'personal', color: CHART_WARNING },
                  ]}
                />
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis
                  dataKey="mes"
                  tickFormatter={fmtMonth}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tickFormatter={(v: number) => fmtCompact(v)}
                />
                <RTooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  cursor={CHART_BAR_CURSOR}
                  labelFormatter={(l: string) => fmtMonth(l)}
                  formatter={(v: number) => formatCOP(v)}
                />
                {/* Apilado: sólo el segmento de arriba lleva radio, si no
                    quedan muescas entre los dos tramos. */}
                <Bar dataKey="negocio" name="Negocio" stackId="gasto"
                     fill="url(#splitGasto-negocio)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="personal" name="Personal" stackId="gasto"
                     fill="url(#splitGasto-personal)" radius={[6, 6, 0, 0]}
                     style={barGlow(CHART_WARNING)} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="text-left hud-label px-2 py-2">Mes</th>
            <th className="text-right hud-label px-2 py-2">
              <span className="inline-flex items-center gap-1"><Briefcase size={11} className="text-info" /> Negocio</span>
            </th>
            <th className="text-right hud-label px-2 py-2">
              <span className="inline-flex items-center gap-1"><User size={11} /> Personal</span>
            </th>
            <th className="text-right hud-label px-2 py-2">Total</th>
            <th className="text-right hud-label px-2 py-2">% personal</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m, idx) => {
            const b = businessByMonth.get(m) ?? 0;
            const p = personalByMonth.get(m) ?? 0;
            const t = b + p;
            const prevPersonal = idx + 1 < months.length ? (personalByMonth.get(months[idx + 1]) ?? 0) : 0;
            const { Icon, tone } = deltaIcon(p, prevPersonal);
            const pct = t > 0 ? Math.round((p / t) * 100) : 0;
            return (
              <tr key={m} className="border-t border-border/50 hover:bg-foreground/[0.035] transition-colors duration-200">
                <td className="px-2 py-2 font-mono tabular-nums">{fmtMonth(m)}</td>
                <td className="text-right px-2 py-2 font-mono tabular-nums text-info">{formatCOP(b)}</td>
                <td className="text-right px-2 py-2 font-mono tabular-nums">
                  <span className="inline-flex items-center justify-end gap-1">
                    <Icon size={11} className={tone} />
                    {formatCOP(p)}
                  </span>
                </td>
                <td className="text-right px-2 py-2 font-mono tabular-nums font-semibold">{formatCOP(t)}</td>
                <td className="text-right px-2 py-2 font-mono tabular-nums">
                  <span className="inline-flex flex-col items-end gap-1 w-full">
                    <span>{pct}%</span>
                    <GradientBar pct={pct} color={CHART_WARNING} height={4} className="w-full min-w-[48px]" />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="relative mt-3 flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d text-xs text-muted-foreground">
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
        <span className="w-9 h-9 rounded-xl bg-warning/20 glow-warning flex items-center justify-center flex-shrink-0 text-warning">
          <AlertTriangle size={17} aria-hidden="true" />
        </span>
        <span className="pt-1">
          "Negocio" = pauta Facebook + TikTok + cursos + software. Todo lo demás cuenta como personal.
          Si ves un mes con % personal alto, ahí estuviste financiando vida con TC en vez de operación.
        </span>
      </div>
    </div>
  );
}

// ─── Top items view: drill-down de un mes ─────────────────────────────

interface TopItemsViewProps {
  yearMonth: string;
  months: string[];
  onChangeMonth: (ym: string) => void;
}

function TopItemsView({ yearMonth, months, onChangeMonth }: TopItemsViewProps) {
  const { data: items = [], isLoading } = usePersonalSpendingTopItems(yearMonth);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-muted-foreground">Mes:</span>
        <select
          value={yearMonth}
          onChange={e => onChangeMonth(e.target.value)}
          className="bg-background border border-border rounded px-2 py-1 text-xs"
        >
          {months.map(m => (
            <option key={m} value={m}>{fmtMonth(m)}</option>
          ))}
        </select>
        <span className="text-muted-foreground">· {items.length} items</span>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground flex items-center gap-2 py-4 justify-center">
          <Loader2 size={14} className="animate-spin" /> Cargando…
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left hud-label px-2 py-2">Fecha</th>
                <th className="text-left hud-label px-2 py-2">Descripción</th>
                <th className="text-left hud-label px-2 py-2">Tarjeta</th>
                <th className="text-left hud-label px-2 py-2">Categoría</th>
                <th className="text-right hud-label px-2 py-2">Cuotas</th>
                <th className="text-right hud-label px-2 py-2">Monto</th>
                <th className="text-right hud-label px-2 py-2">COP</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => {
                const tone = CATEGORIA_TONE[it.categoria] ?? 'muted';
                return (
                  <tr key={it.id} className="border-t border-border/50 hover:bg-foreground/[0.035] transition-colors duration-200">
                    <td className="px-2 py-2 whitespace-nowrap font-mono tabular-nums text-muted-foreground">{it.fecha}</td>
                    <td className="px-2 py-2">
                      <span className="inline-flex items-center gap-1">
                        {it.es_negocio ? <Briefcase size={10} className="text-info" /> : <User size={10} />}
                        <span title={it.descripcion}>{it.descripcion.slice(0, 45)}{it.descripcion.length > 45 ? '…' : ''}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">{it.tarjeta}</td>
                    <td className={`px-2 py-2 ${TONE_TEXT[tone]}`}>{CATEGORIA_LABELS[it.categoria] ?? it.categoria}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {it.cuotas_total && it.cuotas_total > 1 ? (
                        <span className="text-warning">{it.cuotas_total}x{it.interes_anual_pct ? ` @${it.interes_anual_pct}%` : ''}</span>
                      ) : (
                        <span className="text-muted-foreground">1</span>
                      )}
                    </td>
                    {/* La columna mezcla monedas: `$25.00` (USD) y `$25.000`
                        (COP) con el MISMO símbolo se leían como cifras del
                        mismo orden cuando se diferencian ~4.000×. Se prefija
                        "USD " igual que en el resto del módulo (CfoPagosHistorico,
                        CfoPaymentsVsDebt). El número NO cambia. */}
                    <td className="text-right px-2 py-1.5 font-mono tabular-nums whitespace-nowrap">
                      {it.moneda === 'USD' ? `USD ${it.monto.toFixed(2)}` : formatCOP(it.monto)}
                    </td>
                    <td className="text-right px-2 py-1.5 font-mono tabular-nums font-semibold">
                      {formatCOP(it.monto_cop)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
