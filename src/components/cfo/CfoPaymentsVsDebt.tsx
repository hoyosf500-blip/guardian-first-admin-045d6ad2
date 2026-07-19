import { useMemo, useState } from 'react';
import {
  Receipt, ArrowDownRight, ArrowUpRight, AlertTriangle, Loader2,
  CreditCard, TrendingUp,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from 'recharts';
import {
  usePersonalPaymentsSummary, usePersonalResidualDebt,
} from '@/hooks/usePersonalCardMovements';
import { formatCOP } from '@/lib/utils';
import {
  CHART_TOOLTIP_STYLE, CHART_GRID_PROPS, CHART_LINE_CURSOR, fmtCompact,
} from '@/components/logistics/charts/chartTokens';
import {
  BarGradientDefs, SwatchLegend, MoneyFigure,
} from './cfoVisuals';
import {
  lineGlow, barGlow, CHART_SUCCESS, CHART_DANGER, CHART_ACCENT,
} from './cfoChartTokens';

// "Pagado vs Pendiente" — vista cash-flow del bloque de tarjetas
// personales en /cfo. Muestra mes a mes:
//   compras nuevas - pagos = Δ deuda
// Y abajo, el snapshot actual de deuda residual por (tarjeta, moneda).
//
// La TRM es editable porque cambia día a día — afecta solo la conversión
// USD→COP en pantalla, no toca los datos.

interface MonthRow {
  year_month: string;
  compras_total_cop: number;     // todo lo que SUMASTE a la deuda este mes
  pagos_total_cop: number;       // todo lo que RESTASTE a la deuda
  delta: number;                 // compras_total - pagos_total
  saldo_acumulado: number;       // running balance
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

/** Etiqueta corta para el eje del gráfico: "07/26". */
function fmtMonthShort(ym: string): string {
  return `${ym.slice(5, 7)}/${ym.slice(2, 4)}`;
}

export default function CfoPaymentsVsDebt() {
  const [trm, setTrm] = useState<number>(3800);
  // Igual que en CfoPagosHistorico: la TRM arranca en un valor SUPUESTO (3800).
  // Nadie la midió, no viene de ninguna fuente — es el valor inicial del
  // useState. Mientras el usuario no la fije a mano, todo total que mezcle
  // dólares es una CONVERSIÓN estimada y no una cifra dura: se marca con "≈"
  // y con la nota, en vez de imprimirse como si fuera exacta. Si todo está en
  // COP la TRM no toca nada y las cifras sí son duras.
  const [trmFijada, setTrmFijada] = useState<boolean>(false);

  const summaryQuery = usePersonalPaymentsSummary();
  const residualQuery = usePersonalResidualDebt();

  // Pivot ascendente para calcular running balance, después invierto
  const rows: MonthRow[] = useMemo(() => {
    const data = (summaryQuery.data ?? []).slice().sort((a, b) => a.year_month.localeCompare(b.year_month));
    const out: MonthRow[] = [];
    let running = 0;
    for (const r of data) {
      const compras_total =
        r.compras_cop + r.compras_usd * trm
        + r.avances_cop + r.avances_usd * trm
        + r.intereses_cop + r.intereses_usd * trm
        + r.comisiones_cop;
      const pagos_total = r.pagos_cop + r.pagos_usd * trm;
      const delta = compras_total - pagos_total;
      running += delta;
      out.push({
        year_month: r.year_month,
        compras_total_cop: compras_total,
        pagos_total_cop: pagos_total,
        delta,
        saldo_acumulado: running,
      });
    }
    return out.reverse();
  }, [summaryQuery.data, trm]);

  const totales = useMemo(() => {
    const data = summaryQuery.data ?? [];
    return {
      compras_cop:    data.reduce((acc, r) => acc + r.compras_cop, 0),
      compras_usd:    data.reduce((acc, r) => acc + r.compras_usd, 0),
      pagos_cop:      data.reduce((acc, r) => acc + r.pagos_cop, 0),
      pagos_usd:      data.reduce((acc, r) => acc + r.pagos_usd, 0),
      intereses_cop:  data.reduce((acc, r) => acc + r.intereses_cop, 0),
      intereses_usd:  data.reduce((acc, r) => acc + r.intereses_usd, 0),
      avances_cop:    data.reduce((acc, r) => acc + r.avances_cop, 0),
      // `avances_usd` no se sumaba, así que el KPI "Total cargado" lo perdía
      // entero — mientras la fila mensual (y por lo tanto la gráfica, que
      // plotea `compras_total_cop`) SÍ lo convierte. Con avances en dólares la
      // suma de las barras no daba el KPI impreso justo encima.
      avances_usd:    data.reduce((acc, r) => acc + r.avances_usd, 0),
      comisiones_cop: data.reduce((acc, r) => acc + r.comisiones_cop, 0),
    };
  }, [summaryQuery.data]);

  const residualByCard = residualQuery.data ?? [];
  const residual_total_cop = residualByCard.reduce(
    (acc, r) => acc + (r.moneda === 'USD' ? r.saldo_pendiente * trm : r.saldo_pendiente),
    0,
  );

  const total_pagado_cop = totales.pagos_cop + totales.pagos_usd * trm;
  // MISMOS términos y mismo orden que `compras_total` de la fila mensual
  // (arriba), para que la suma de las barras de la gráfica dé exactamente este
  // KPI. Antes faltaba `avances_usd * trm` y las dos cifras se contradecían.
  const total_cargado_cop =
    totales.compras_cop + totales.compras_usd * trm
    + totales.avances_cop + totales.avances_usd * trm
    + totales.intereses_cop + totales.intereses_usd * trm
    + totales.comisiones_cop;

  // ── Honestidad de la conversión USD→COP ──────────────────────────
  // Porción en dólares de cada KPI: es la única que depende de la TRM. Si es 0,
  // el total es COP puro y no hay nada que estimar.
  const usdPagado = totales.pagos_usd;
  // TODOS los dólares que entran en `total_cargado_cop` — incluidos los
  // avances. Si acá falta una rama, un mes con avances en dólares dibuja tabla
  // y gráfica convertidas a la TRM supuesta SIN ninguna marca ni nota.
  const usdCargado = totales.compras_usd + totales.avances_usd + totales.intereses_usd;
  const usdResidual = residualByCard.reduce(
    (acc, r) => acc + (r.moneda === 'USD' ? r.saldo_pendiente : 0),
    0,
  );
  const pagadoEsEstimado   = usdPagado > 0 && !trmFijada;
  const cargadoEsEstimado  = usdCargado > 0 && !trmFijada;
  const residualEsEstimado = usdResidual > 0 && !trmFijada;

  const notaTrm = (usd: number) =>
    `Incluye USD ${usd.toFixed(2)} convertido a TRM ${trm.toLocaleString('es-CO')}`
    + (trmFijada ? ' (fijada a mano).' : ' — tasa supuesta, nadie la verificó.');

  // Serie ascendente para el gráfico (la tabla va descendente). Mismos números
  // de `rows`, sólo en el orden en que se leen en un eje temporal.
  const chartRows = useMemo(() => [...rows].reverse(), [rows]);

  if (summaryQuery.isLoading || residualQuery.isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-6 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Cargando flujo de pagos…</span>
      </div>
    );
  }

  if ((summaryQuery.data ?? []).length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
        Aún no hay datos. Subí los extractos de las TC en el bloque de arriba para verlo.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top p-5 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 shrink-0 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center">
            <Receipt size={17} aria-hidden="true" />
          </span>
          <h3 className="font-semibold text-sm">Pagado vs Pendiente</h3>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">TRM USD→COP:</label>
          <input
            type="number"
            value={trm}
            onChange={e => {
              const v = Number(e.target.value);
              setTrm(v || 3800);
              // Solo cuenta como "fijada" si quedó un número usable; si borra el
              // campo volvemos al supuesto 3800 y a marcar los totales como ≈.
              setTrmFijada(Number.isFinite(v) && v > 0);
            }}
            min={1000}
            max={10000}
            step={10}
            className="w-20 bg-card/40 border border-border rounded-lg px-2 py-1 text-xs font-mono tabular-nums hover:border-border-strong transition-colors"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KpiCard
          icon={<ArrowUpRight size={17} />}
          label="Total pagado"
          value={formatCOP(total_pagado_cop)}
          estimado={pagadoEsEstimado}
          nota={usdPagado > 0 ? notaTrm(usdPagado) : undefined}
          subValue={`${formatCOP(totales.pagos_cop)} COP + USD ${totales.pagos_usd.toFixed(2)}`}
          tone="success"
        />
        <KpiCard
          icon={<ArrowDownRight size={17} />}
          label="Total cargado"
          value={formatCOP(total_cargado_cop)}
          estimado={cargadoEsEstimado}
          nota={usdCargado > 0 ? notaTrm(usdCargado) : undefined}
          subValue={`${formatCOP(totales.compras_cop)} COP + USD ${totales.compras_usd.toFixed(2)}`}
          tone="warning"
        />
        <KpiCard
          icon={<CreditCard size={17} />}
          label="Deuda residual actual"
          value={formatCOP(residual_total_cop)}
          estimado={residualEsEstimado}
          nota={usdResidual > 0 ? notaTrm(usdResidual) : undefined}
          subValue={residualByCard.length > 0
            ? residualByCard.map(r => `${r.tarjeta}: ${r.moneda === 'USD' ? `USD ${r.saldo_pendiente.toFixed(2)}` : formatCOP(r.saldo_pendiente)}`).join(' · ')
            : 'Sin deuda residual'}
          tone="danger"
        />
      </div>

      {/* Mismos números de la tabla de abajo, dibujados: barras de lo cargado
          vs lo pagado cada mes y la línea del acumulado por encima. */}
      {chartRows.length > 1 && (
        <div className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d hairline-top">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
            <h4 className="text-xs font-semibold text-foreground flex items-center gap-2">
              <TrendingUp size={14} className="text-accent" aria-hidden="true" />
              Cargado vs pagado por mes
            </h4>
            <SwatchLegend
              items={[
                { color: CHART_DANGER,  label: 'Cargado' },
                { color: CHART_SUCCESS, label: 'Pagado' },
                { color: CHART_ACCENT,  label: 'Acumulado' },
              ]}
            />
          </div>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
                <BarGradientDefs
                  prefix="pagosVsDeuda"
                  entries={[
                    { key: 'cargado', color: CHART_DANGER },
                    { key: 'pagado',  color: CHART_SUCCESS },
                  ]}
                />
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis
                  dataKey="year_month"
                  tickFormatter={fmtMonthShort}
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
                  cursor={CHART_LINE_CURSOR}
                  labelFormatter={(l: string) => fmtMonth(l)}
                  formatter={(v: number) => formatCOP(v)}
                />
                <Bar
                  dataKey="compras_total_cop"
                  name="Cargado"
                  fill="url(#pagosVsDeuda-cargado)"
                  radius={[6, 6, 0, 0]}
                />
                <Bar
                  dataKey="pagos_total_cop"
                  name="Pagado"
                  fill="url(#pagosVsDeuda-pagado)"
                  radius={[6, 6, 0, 0]}
                  style={barGlow(CHART_SUCCESS)}
                />
                {/* El acumulado es un TOTAL sobre las otras dos series: va
                    punteado, como en el resto del DS. */}
                <Line
                  type="monotone"
                  dataKey="saldo_acumulado"
                  name="Acumulado"
                  stroke={CHART_ACCENT}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray="5 5"
                  dot={false}
                  style={lineGlow(CHART_ACCENT)}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-2 py-2">Mes</th>
              <th className="text-right font-medium px-2 py-2">
                <span className="inline-flex items-center gap-1">
                  <ArrowDownRight size={11} className="text-danger" /> Cargado
                </span>
              </th>
              <th className="text-right font-medium px-2 py-2">
                <span className="inline-flex items-center gap-1">
                  <ArrowUpRight size={11} className="text-success" /> Pagado
                </span>
              </th>
              <th className="text-right font-medium px-2 py-2">Δ deuda</th>
              <th className="text-right font-medium px-2 py-2">Acumulado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isAhorro = r.delta < 0;
              return (
                <tr key={r.year_month} className="border-t border-border hover:bg-foreground/[0.035] transition-colors">
                  <td className="px-2 py-2 capitalize">{fmtMonth(r.year_month)}</td>
                  <td className="text-right px-2 py-2 font-mono tabular-nums">{formatCOP(r.compras_total_cop)}</td>
                  <td className="text-right px-2 py-2 font-mono tabular-nums text-success">{formatCOP(r.pagos_total_cop)}</td>
                  <td className={`text-right px-2 py-2 font-mono tabular-nums font-medium ${isAhorro ? 'text-success' : 'text-danger'}`}>
                    {isAhorro ? '' : '+'}{formatCOP(r.delta)}
                  </td>
                  <td className="text-right px-2 py-2 font-mono tabular-nums font-semibold">
                    {formatCOP(r.saldo_acumulado)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* La tabla (y el gráfico) también convierten los dólares con la misma
          tasa supuesta. Se dice una vez, en vez de repetir "≈" celda por celda. */}
      {!trmFijada && (usdPagado > 0 || usdCargado > 0) && (
        <p className="text-[10px] text-muted-foreground">
          Las cifras en pesos convierten los dólares a una TRM supuesta ({trm.toLocaleString('es-CO')}) — fijá la TRM arriba para que dejen de ser estimadas.
        </p>
      )}

      {residualByCard.length > 0 && (
        <div className="rounded-2xl border border-border bg-foreground/[0.03] p-3 space-y-2 shadow-card3d hairline-top">
          <h4 className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            <CreditCard size={12} /> Deuda residual actual por tarjeta
          </h4>
          <div className="space-y-1">
            {residualByCard.map(r => (
              <div key={`${r.tarjeta}-${r.moneda}`} className="flex justify-between text-xs">
                <span>
                  {r.tarjeta} <span className="text-muted-foreground">· {r.marca} · {r.num_compras} compras a cuotas</span>
                </span>
                <span className="font-mono tabular-nums font-medium">
                  {r.moneda === 'USD'
                    ? `USD ${r.saldo_pendiente.toFixed(2)} ≈ ${formatCOP(r.saldo_pendiente * trm)}`
                    : formatCOP(r.saldo_pendiente)
                  }
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle size={12} className="mt-0.5 text-warning shrink-0" />
        <span>
          <strong>Acumulado</strong> es lo que vas debiendo después de cada mes (compras − pagos sumado mes a mes).
          <strong className="ml-1">Δ deuda en rojo</strong> = creció la deuda; <strong className="text-success">en verde</strong> = pagaste más de lo que cargaste.
          <strong className="ml-1">Deuda residual</strong> = lo que el banco dice que te falta hoy en cuotas diferidas.
        </span>
      </div>
    </div>
  );
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  /** true = la cifra mezcla dólares convertidos a una TRM que nadie verificó. */
  estimado?: boolean;
  /** Nota de conversión (de dónde salen los dólares y a qué tasa). */
  nota?: string;
}

const KPI_TONE: Record<string, { card: string; chip: string; text: string; num: string }> = {
  success: {
    card: 'border-success/28 bg-success/[0.07]',
    chip: 'bg-success/14 border-success/30 text-success glow-success',
    text: 'text-success', num: 'num-glow-success',
  },
  warning: {
    card: 'border-warning/28 bg-warning/[0.07]',
    chip: 'bg-warning/14 border-warning/30 text-warning glow-warning',
    // index.css no define num-glow-warning — va sin glow, no se inventa token.
    text: 'text-warning', num: '',
  },
  danger: {
    card: 'border-danger/28 bg-danger/[0.07]',
    chip: 'bg-danger/14 border-danger/30 text-danger glow-danger',
    text: 'text-danger', num: 'num-glow-danger',
  },
  muted: {
    card: 'border-border bg-card/40',
    chip: 'bg-muted/60 border-border text-muted-foreground',
    text: 'text-foreground', num: '',
  },
};

function KpiCard({ icon, label, value, subValue, tone, estimado = false, nota }: KpiCardProps) {
  const t = KPI_TONE[tone];
  return (
    <div className={`rounded-2xl border shadow-card3d hairline-top p-4 transition-colors duration-200 hover:border-border-strong ${t.card}`}>
      <span className={`w-9 h-9 rounded-xl border flex items-center justify-center ${t.chip}`}>
        {icon}
      </span>
      <div className={`text-[26px] font-bold leading-none mt-3 ${t.text} ${t.num}`}>
        {/* El "≈" no es decorativo: avisa que el número mezcla dólares
            convertidos a una tasa supuesta. Sin dólares en juego no aparece. */}
        {estimado && <span className="text-[0.55em] font-semibold mr-1 align-baseline opacity-80">≈</span>}
        <MoneyFigure text={value} />
      </div>
      <div className="hud-label text-subtle mt-2">{label}</div>
      <div className="text-[11px] text-muted-foreground font-mono tabular-nums truncate mt-1.5" title={subValue}>{subValue}</div>
      {nota && (
        <div className="text-[10px] text-muted-foreground mt-1 leading-snug">{nota}</div>
      )}
    </div>
  );
}
