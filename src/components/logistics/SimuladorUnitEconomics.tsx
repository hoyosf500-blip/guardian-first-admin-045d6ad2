import { useEffect, useMemo, useState } from 'react';
import {
  Calculator, Truck, PackageCheck, Undo2, TrendingDown, Receipt, RefreshCw,
} from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import KpiCard from '@/components/logistics/finanzas/KpiCard';
import {
  computeRealKpis, computeSimulation, type SimulationInput,
} from '@/lib/unitEconomics';
import type { LogisticsCostBasis } from '@/hooks/useLogisticsCostBasis';

// "Indicadores & Simulador" de "/logistica → Cómo voy": KPIs de unit-economics
// REALES (tasa de despachos, entrega, % devolución, inefectividad, ticket) + un
// simulador de ganancia estilo calculadora de precios, con los % seedeados de lo
// real y EDITABLES para simular escenarios (what-if efímero, no persiste).
//
// COGS + flete reales llegan por `costBasis` (RPC store-scoped logistics_cost_basis).
// Si es null (migration sin aplicar), el panel sigue mostrando KPIs + cascada y el
// simulador degrada a inputs en cero con un aviso. La ganancia acá es CONTABLE
// (ingresos − costos), distinta de la caja del wallet por fecha de pago.

interface Props {
  // Cascada real (de los buckets del embudo)
  generadosSinCancel: number;
  totalVendido: number;       // valor facturado sin cancelar
  despachadosCount: number;
  despachadoValor: number;
  entregadosCount: number;
  valorEntregado: number;
  devueltosCount: number;
  valorPerdido: number;
  // Base de costos real (RPC) — puede ser null si la migration no está aplicada
  costBasis: LogisticsCostBasis | null;
  costBasisLoading: boolean;
  // Costos mensuales ya cargados (NetoRealCard los persiste)
  pautaTotal: number;         // pauta_meta + pauta_tiktok
  adminTotal: number;         // costos_admin
}

function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// COP enteros: descartamos todo lo que no sea dígito (acepta "1.000.000").
function parseCop(v: string): number {
  const n = Number(v.replace(/[^\d]/g, ''));
  return isFinite(n) ? n : 0;
}
// % editable: acepta coma o punto decimal, devuelve 0-1.
function parsePct(v: string): number {
  const n = Number(v.replace(/[^\d.,]/g, '').replace(',', '.'));
  return isFinite(n) ? n / 100 : 0;
}

export default function SimuladorUnitEconomics({
  generadosSinCancel, totalVendido, despachadosCount, despachadoValor,
  entregadosCount, valorEntregado, devueltosCount, valorPerdido,
  costBasis, costBasisLoading, pautaTotal, adminTotal,
}: Props) {
  const kpis = useMemo(
    () => computeRealKpis({
      generadosSinCancel,
      despachados: despachadosCount,
      entregados: entregadosCount,
      devueltos: devueltosCount,
      valorEntregado,
    }),
    [generadosSinCancel, despachadosCount, entregadosCount, devueltosCount, valorEntregado],
  );

  // Base de ingresos para los % de costo: la del RPC si está, si no el valor del bucket.
  const ingresosBase = costBasis?.ingresos_entregados ?? valorEntregado;
  const cogs = costBasis?.cogs_entregados ?? 0;
  const flete = costBasis?.flete_entregados ?? 0;
  const fleteUnit = costBasis && costBasis.entregados > 0
    ? costBasis.flete_entregados / costBasis.entregados
    : 0;

  // Seeds reales para el simulador (0-1 para %, COP para montos).
  const seed = useMemo<SimulationInput>(() => ({
    pedidos: Math.round(generadosSinCancel),
    ticket: Math.round(kpis.ticketPromedio),
    tasaDespachos: kpis.tasaDespachos,
    pctDevolucion: kpis.pctDevolucion,
    costoProductoPct: ingresosBase > 0 ? cogs / ingresosBase : 0,
    fletePct: ingresosBase > 0 ? flete / ingresosBase : 0,
    publicidadPct: ingresosBase > 0 ? pautaTotal / ingresosBase : 0,
    adminPct: ingresosBase > 0 ? adminTotal / ingresosBase : 0,
    costoDevolucionUnit: Math.round(fleteUnit),
  }), [generadosSinCancel, kpis, ingresosBase, cogs, flete, pautaTotal, adminTotal, fleteUnit]);

  const [sim, setSim] = useState<SimulationInput>(seed);
  // Re-seedear cuando llegan/cambian los datos reales (el usuario edita por encima
  // hasta que cambia el mes/los datos). Mismo patrón que NetoRealCard.
  useEffect(() => { setSim(seed); }, [seed]);

  const result = useMemo(() => computeSimulation(sim), [sim]);
  const dirty = useMemo(
    () => (Object.keys(seed) as (keyof SimulationInput)[]).some((k) => sim[k] !== seed[k]),
    [sim, seed],
  );

  const set = (patch: Partial<SimulationInput>) => setSim((s) => ({ ...s, ...patch }));
  const sinCostos = !costBasis && !costBasisLoading;

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-3 border-b border-border flex items-center gap-2">
        <Calculator size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-foreground">Indicadores &amp; Simulador</h3>
        <span className="text-[11px] text-muted-foreground ml-auto">unit-economics del mes</span>
      </header>

      {/* KPIs reales */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 p-4">
        <KpiCard label="Tasa de despachos" value={pct1(kpis.tasaDespachos)} icon={Truck} tone="info"
          hint={`${despachadosCount} de ${generadosSinCancel} generados`} />
        <KpiCard label="Tasa de entrega" value={pct1(kpis.tasaEntrega)} icon={PackageCheck} tone="success"
          hint={`${entregadosCount} de ${despachadosCount} despachados`} />
        <KpiCard label="% Devolución" value={pct1(kpis.pctDevolucion)} icon={Undo2} tone="danger"
          hint={`${devueltosCount} devueltos`} />
        <KpiCard label="% Inefectividad" value={pct1(kpis.pctInefectividad)} icon={TrendingDown} tone="warning"
          hint="no entregado / generado" />
        <KpiCard label="Ticket promedio" value={formatCOP(kpis.ticketPromedio)} icon={Receipt} tone="accent"
          hint="por pedido entregado" />
      </div>

      {/* Cascada real */}
      <div className="px-4 pb-4">
        <div className="rounded-lg border border-border bg-muted/10 divide-y divide-border text-sm">
          <CascadaRow label="Facturado" sub="pedidos generados" count={generadosSinCancel} valor={totalVendido} tone="base" />
          <CascadaRow label="Despachado" sub="salió a la transportadora" count={Math.round(despachadosCount)} valor={despachadoValor} tone="muted" />
          <CascadaRow label="Entregado" sub="realizado" count={entregadosCount} valor={valorEntregado} tone="success" />
          <CascadaRow label="Devolución" sub="perdido" count={devueltosCount} valor={valorPerdido} tone="danger" />
        </div>
      </div>

      {/* Simulador */}
      <div className="border-t border-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
            Simulador de ganancia
          </span>
          {dirty && (
            <button
              onClick={() => setSim(seed)}
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              <RefreshCw size={11} /> Restaurar reales
            </button>
          )}
        </div>

        {sinCostos && (
          <p className="text-[11px] text-warning leading-relaxed">
            Faltan los costos reales (COGS y flete): aplicá la migration <code className="font-mono">logistics_cost_basis</code>.
            Mientras tanto podés tipear los % a mano.
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <NumField label="# Pedidos" value={sim.pedidos} onChange={(n) => set({ pedidos: n })} />
          <CopField label="Ticket" value={sim.ticket} onChange={(n) => set({ ticket: n })} />
          <PctField label="Tasa despachos" value={sim.tasaDespachos} onChange={(n) => set({ tasaDespachos: n })} />
          <PctField label="% Devolución" value={sim.pctDevolucion} onChange={(n) => set({ pctDevolucion: n })} />
          <PctField label="Costo producto" value={sim.costoProductoPct} onChange={(n) => set({ costoProductoPct: n })} />
          <PctField label="Flete" value={sim.fletePct} onChange={(n) => set({ fletePct: n })} />
          <PctField label="Publicidad" value={sim.publicidadPct} onChange={(n) => set({ publicidadPct: n })} />
          <PctField label="Admin" value={sim.adminPct} onChange={(n) => set({ adminPct: n })} />
          <CopField label="Costo x devolución" value={sim.costoDevolucionUnit} onChange={(n) => set({ costoDevolucionUnit: n })} />
        </div>

        {/* Proyección */}
        <div className="rounded-lg border border-border bg-muted/10 divide-y divide-border text-sm mt-1">
          <SimRow label="Ingresos (entregados)" value={result.ingresos} tone="base"
            sub={`${Math.round(result.entregadoPedidos)} entregas`} />
          <SimRow label="Costo de producto" value={-result.cogs} tone="muted" />
          <SimRow label="Flete" value={-result.flete} tone="muted" />
          <SimRow label="Publicidad" value={-result.publicidad} tone="muted" />
          <SimRow label="Admin" value={-result.admin} tone="muted" />
          <SimRow label="Costo de devoluciones" value={-result.costoDevolucion} tone="danger"
            sub={`${Math.round(result.devueltoPedidos)} devueltos`} />
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5">
          <span className="text-xs text-foreground font-medium">
            Ganancia neta
            <span className="block text-[10px] text-muted-foreground/70">
              {pct1(result.gananciaPct)} sobre facturado · {pct1(result.margenEntregaPct)} sobre entregado
            </span>
          </span>
          <span className={`text-lg font-bold tabular-nums shrink-0 ${result.gananciaNeta >= 0 ? 'text-green' : 'text-red'}`}>
            {formatCOP(result.gananciaNeta)}
          </span>
        </div>

        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Proyección sobre tus tasas reales del mes. La ganancia acá es <strong className="text-foreground">contable</strong> (ingresos
          de entregados − costos), distinta de la <strong className="text-foreground">caja del wallet</strong> (que va por fecha de pago).
          Editá cualquier casilla para simular escenarios; no se guarda.
        </p>
      </div>
    </section>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────────

function CascadaRow({
  label, sub, count, valor, tone,
}: { label: string; sub: string; count: number; valor: number; tone: 'base' | 'muted' | 'success' | 'danger' }) {
  const valTone =
    tone === 'success' ? 'text-green'
    : tone === 'danger' ? 'text-red'
    : tone === 'muted' ? 'text-muted-foreground'
    : 'text-foreground';
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 py-2">
      <span className="text-xs text-foreground/90">
        {label} <span className="text-[10px] text-muted-foreground">· {sub}</span>
      </span>
      <span className="flex items-baseline gap-3 shrink-0 tabular-nums">
        <span className="text-xs font-bold text-foreground">{count.toLocaleString('es-CO')}</span>
        <span className={`text-xs font-mono w-28 text-right ${valTone}`}>{formatCOP(valor)}</span>
      </span>
    </div>
  );
}

function SimRow({
  label, value, tone, sub,
}: { label: string; value: number; tone: 'base' | 'muted' | 'danger'; sub?: string }) {
  const isNeg = value < 0;
  const valTone = tone === 'danger' ? 'text-red' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 py-1.5">
      <span className="text-xs text-foreground/90">
        {label}{sub && <span className="text-[10px] text-muted-foreground ml-1.5">· {sub}</span>}
      </span>
      <span className={`text-xs font-mono tabular-nums shrink-0 ${valTone}`}>
        {isNeg ? '−' : ''}{formatCOP(Math.abs(value))}
      </span>
    </div>
  );
}

function FieldShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded border border-border bg-background px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-accent';

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <FieldShell label={label}>
      <input
        type="text" inputMode="numeric"
        value={value === 0 ? '' : String(value)} placeholder="0"
        onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, '')) || 0)}
        className={inputCls}
      />
    </FieldShell>
  );
}

function CopField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <FieldShell label={label}>
      <input
        type="text" inputMode="numeric"
        value={value === 0 ? '' : String(value)} placeholder="$0"
        onChange={(e) => onChange(parseCop(e.target.value))}
        className={inputCls}
      />
    </FieldShell>
  );
}

function PctField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  // value es 0-1; mostramos el % con hasta 1 decimal, sin ceros colgando.
  const display = value === 0 ? '' : String(Math.round(value * 1000) / 10);
  return (
    <FieldShell label={`${label} %`}>
      <input
        type="text" inputMode="decimal"
        value={display} placeholder="0"
        onChange={(e) => onChange(parsePct(e.target.value))}
        className={inputCls}
      />
    </FieldShell>
  );
}
