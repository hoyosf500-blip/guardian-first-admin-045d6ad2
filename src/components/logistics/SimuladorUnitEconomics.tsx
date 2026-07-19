import { useEffect, useMemo, useState, type ElementType } from 'react';
import {
  Calculator, Truck, PackageCheck, Undo2, TrendingDown, Receipt, RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { formatCOP, getCurrencyCountry } from '@/lib/utils';
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
  devueltosCount: number;       // devoluciones reales (sin rechazos)
  valorPerdido: number;
  rechazadosCount: number;      // rechazos del cliente (aparte)
  valorRechazos: number;
  // Base de costos real (RPC) — puede ser null si la migration no está aplicada
  costBasis: LogisticsCostBasis | null;
  costBasisLoading: boolean;
  // Costos mensuales ya cargados (NetoRealCard los persiste)
  pautaTotal: number;         // pauta_meta + pauta_tiktok
  adminTotal: number;         // costos_admin
  // Rango activo — para prorratear pauta/admin (MENSUALES) a la ventana visible.
  fromDate: string;           // 'YYYY-MM-DD'
  toDate: string;             // 'YYYY-MM-DD'
}

/** Fracción del mes que cubre el rango [from,to] (0-1). pauta/admin son costos
 *  MENSUALES; sin prorratear, a día 3 del mes el gasto entero se dividía entre 3
 *  días de ingresos → publicidad% inflado ~10x. Prorratea por días cubiertos. */
function fraccionMesCubierta(from: string, to: string): number {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  if (isNaN(f.getTime()) || isNaN(t.getTime()) || t < f) return 1;
  const diasRango = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const diasEnMes = new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate();
  return Math.max(0, Math.min(1, diasRango / diasEnMes));
}

function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// Montos: en CO son COP enteros (descartamos todo lo no-dígito, acepta
// "1.000.000" donde el punto es separador de miles). En EC son USD con
// decimales: "6.49" debe ser 6.49, NO 649 — el punto/coma es decimal.
function parseCop(v: string): number {
  if (getCurrencyCountry() === 'EC') {
    const n = Number(v.replace(/[^\d.,-]/g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  const n = Number(v.replace(/[^\d]/g, ''));
  return isFinite(n) ? n : 0;
}

// Redondeo a centavos (no a enteros): en EC un ticket de $32.48 o un flete de
// $6.49 redondeados a entero distorsionan toda la simulación.
const round2 = (n: number) => Math.round(n * 100) / 100;
// % editable: acepta coma o punto decimal, devuelve 0-1.
function parsePct(v: string): number {
  const n = Number(v.replace(/[^\d.,]/g, '').replace(',', '.'));
  return isFinite(n) ? n / 100 : 0;
}

export default function SimuladorUnitEconomics({
  generadosSinCancel, totalVendido, despachadosCount, despachadoValor,
  entregadosCount, valorEntregado, devueltosCount, valorPerdido,
  rechazadosCount, valorRechazos,
  costBasis, costBasisLoading, pautaTotal, adminTotal,
  fromDate, toDate,
}: Props) {
  // pauta/admin son mensuales; prorrateamos al rango para que numerador (costo) y
  // denominador (ingresos del rango) cubran la misma ventana.
  const fracMes = useMemo(() => fraccionMesCubierta(fromDate, toDate), [fromDate, toDate]);
  const pautaProrateada = pautaTotal * fracMes;
  const adminProrateado = adminTotal * fracMes;
  const kpis = useMemo(
    () => computeRealKpis({
      generadosSinCancel,
      despachados: despachadosCount,
      entregados: entregadosCount,
      devueltos: devueltosCount,
      rechazados: rechazadosCount,
      valorEntregado,
    }),
    [generadosSinCancel, despachadosCount, entregadosCount, devueltosCount, rechazadosCount, valorEntregado],
  );
  // Resueltos = entregados + devoluciones reales (denominador de la tasa madura).
  const resueltos = entregadosCount + devueltosCount;

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
    ticket: round2(kpis.ticketPromedio),
    tasaDespachos: kpis.tasaDespachos,
    // El simulador proyecta "de lo despachado, qué fracción falla". El estimador
    // honesto es sobre CONCLUIDOS ((dev+rech)/(entreg+dev+rech)): la versión
    // anterior dividía por despachados CON lo aún en tránsito → a mitad de mes
    // asumía que todo lo en camino entregaba y la ganancia proyectada quedaba
    // inflada (auditoría 2026-07-07).
    pctDevolucion: kpis.pctNoEntregaProyeccion,
    costoProductoPct: ingresosBase > 0 ? cogs / ingresosBase : 0,
    fletePct: ingresosBase > 0 ? flete / ingresosBase : 0,
    publicidadPct: ingresosBase > 0 ? pautaProrateada / ingresosBase : 0,
    adminPct: ingresosBase > 0 ? adminProrateado / ingresosBase : 0,
    costoDevolucionUnit: round2(fleteUnit),
  }), [generadosSinCancel, kpis, ingresosBase, cogs, flete, pautaProrateada, adminProrateado, fleteUnit]);

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
    <section className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong">
      <header className="px-5 py-3.5 border-b border-border flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Calculator size={14} className="text-accent" aria-hidden="true" />
          Indicadores &amp; Simulador
        </h3>
        <span className="hud-label ml-auto">unit-economics del mes</span>
      </header>

      {/* KPIs reales — anatomía del Dashboard (chip de 36px con glow · cifra ·
          rótulo en .hud-label BAJO la cifra · hint al pie). No es <StatTile>
          porque acá el valor ya viene formateado como string ("38.5%",
          formatCOP) y StatTile sólo acepta un number crudo. */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 p-4">
        <UnitKpi label="Tasa de despachos" value={pct1(kpis.tasaDespachos)} icon={Truck} tone="info"
          hint={`${despachadosCount} de ${generadosSinCancel} generados`} />
        <UnitKpi label="Tasa de entrega" value={pct1(kpis.tasaEntrega)} icon={PackageCheck} tone="success"
          hint={`${entregadosCount} de ${resueltos} resueltos · sin rechazos`} />
        <UnitKpi label="% Devolución" value={pct1(kpis.pctDevolucion)} icon={Undo2} tone="danger"
          hint={`${devueltosCount} de ${resueltos} resueltos`} />
        <UnitKpi label="% Rechazo" value={pct1(kpis.pctRechazo)} icon={Undo2} tone="warning"
          hint={`${rechazadosCount} rechazados / despachado`} />
        <UnitKpi label="% Inefectividad" value={pct1(kpis.pctInefectividad)} icon={TrendingDown} tone="warning"
          hint="no entregado / generado · incluye lo aún en camino: baja solo al madurar el mes" />
        <UnitKpi label="Ticket promedio" value={formatCOP(kpis.ticketPromedio)} icon={Receipt} tone="accent"
          hint="por pedido entregado" />
      </div>

      {/* Cascada real — ahora con barra proporcional sobre el facturado (la base
          del embudo), igual que el embudo de MesActualResumen. La barra no
          agrega ningún número a la pantalla: es el mismo `count` de la fila
          medido contra la primera fila. Sin base (`generadosSinCancel <= 0`) no
          se dibuja ninguna barra: no habría contra qué proporcionar. */}
      <div className="px-4 pb-4">
        <div className="rounded-2xl border border-border bg-muted/10 divide-y divide-border shadow-card3d">
          <CascadaRow label="Facturado" sub="pedidos generados" count={generadosSinCancel} valor={totalVendido} tone="base" base={generadosSinCancel} />
          <CascadaRow label="Despachado" sub="salió a la transportadora" count={Math.round(despachadosCount)} valor={despachadoValor} tone="muted" base={generadosSinCancel} />
          <CascadaRow label="Entregado" sub="realizado" count={entregadosCount} valor={valorEntregado} tone="success" base={generadosSinCancel} />
          <CascadaRow label="Devolución" sub="devolución logística" count={devueltosCount} valor={valorPerdido} tone="danger" base={generadosSinCancel} />
          <CascadaRow label="Rechazo" sub="cliente rechazó" count={rechazadosCount} valor={valorRechazos} tone="danger" base={generadosSinCancel} />
        </div>
      </div>

      {/* Simulador */}
      <div className="border-t border-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="hud-label">Simulador de ganancia</span>
          {dirty && (
            <button
              onClick={() => setSim(seed)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-card/40 border border-border text-muted-foreground text-[11px] font-medium hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <RefreshCw size={11} aria-hidden="true" /> Restaurar reales
            </button>
          )}
        </div>

        {sinCostos && (
          // Mismo banner de estado que el resto del módulo: barra lateral + chip.
          <div className="relative flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d">
            <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-warning/20 glow-warning">
              <AlertTriangle size={17} className="text-warning" aria-hidden="true" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed flex-1 min-w-0">
              Faltan los costos reales (COGS y flete): aplicá la migration <code className="font-mono text-[10px]">logistics_cost_basis</code>.
              Mientras tanto podés tipear los % a mano.
            </p>
          </div>
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
        <div className="rounded-2xl border border-border bg-muted/10 divide-y divide-border shadow-card3d mt-1">
          <SimRow label="Ingresos (entregados)" value={result.ingresos} tone="base"
            sub={`${Math.round(result.entregadoPedidos)} entregas`} />
          <SimRow label="Costo de producto" value={-result.cogs} tone="muted" />
          <SimRow label="Flete" value={-result.flete} tone="muted" />
          <SimRow label="Publicidad" value={-result.publicidad} tone="muted" />
          <SimRow label="Admin" value={-result.admin} tone="muted" />
          <SimRow label="Costo de devoluciones" value={-result.costoDevolucion} tone="danger"
            sub={`${Math.round(result.devueltoPedidos)} devueltos`} />
        </div>

        {/* Cierre del bloque: la cifra protagonista del simulador, con el chip
            de ícono y el tamaño de una tarjeta de resumen. Tokens alineados con
            el resto del lenguaje (success/danger en vez de green/red). */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/40 px-4 py-3.5 shadow-card3d hairline-top">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${
              result.gananciaNeta >= 0
                ? 'bg-success/14 border-success/30 text-success glow-success'
                : 'bg-danger/14 border-danger/30 text-danger glow-danger'
            }`}>
              <Calculator size={17} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block hud-label">Ganancia neta</span>
              <span className="block text-[10px] text-muted-foreground/70 mt-1 font-mono tabular-nums">
                {pct1(result.gananciaPct)} sobre facturado · {pct1(result.margenEntregaPct)} sobre entregado
              </span>
            </span>
          </div>
          <span className={`text-2xl font-mono font-bold tabular-nums leading-none shrink-0 ${result.gananciaNeta >= 0 ? 'text-success' : 'text-danger'}`}>
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

type UnitTone = 'success' | 'danger' | 'info' | 'warning' | 'accent';

const UNIT_TONE: Record<UnitTone, { chip: string; text: string }> = {
  success: { chip: 'bg-success/14 border-success/30 text-success glow-success', text: 'text-success' },
  danger:  { chip: 'bg-danger/14 border-danger/30 text-danger glow-danger',     text: 'text-danger' },
  info:    { chip: 'bg-info/14 border-info/30 text-info glow-info',             text: 'text-info' },
  warning: { chip: 'bg-warning/14 border-warning/30 text-warning glow-warning', text: 'text-warning' },
  accent:  { chip: 'bg-accent/14 border-accent/30 text-accent glow-accent',     text: 'text-accent' },
};

/** KPI de unit-economics con la anatomía del Dashboard. Valor ya formateado. */
function UnitKpi({
  label, value, icon: Icon, tone, hint,
}: { label: string; value: string; icon: ElementType; tone: UnitTone; hint?: string }) {
  const t = UNIT_TONE[tone];
  // Mismo criterio que finanzas/KpiCard: un "—" es un HUECO, no una medición.
  // Se atenúa en vez de pintarse a todo color con chip glow, para que no se
  // lea como un valor medido. Hoy `pct1` siempre devuelve algo, así que es una
  // defensa por si mañana alguna de las 6 cifras puede venir vacía.
  const sinDato = value === '—';
  return (
    <div className={`rounded-2xl border bg-card/40 p-4 shadow-card3d hairline-top h-full flex flex-col transition-colors duration-200 hover:border-border-strong ${sinDato ? 'border-border/50 opacity-75' : 'border-border'}`}>
      <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${sinDato ? 'bg-muted/50 border-border text-muted-foreground' : t.chip}`}>
        <Icon size={17} aria-hidden="true" />
      </span>
      <div className={`text-2xl font-mono tabular-nums font-bold leading-none mt-3 ${sinDato ? 'text-muted-foreground' : t.text}`}>
        {value}
      </div>
      <div className="hud-label mt-2">{label}</div>
      {hint && (
        <div className="mt-2 text-[11px] text-muted-foreground leading-snug">{hint}</div>
      )}
    </div>
  );
}

const CASCADA_BAR: Record<'base' | 'muted' | 'success' | 'danger', string> = {
  base:    'bg-accent-gradient',
  muted:   'bg-muted-foreground/45',
  success: 'bg-success',
  danger:  'bg-danger',
};

function CascadaRow({
  label, sub, count, valor, tone, base,
}: {
  label: string; sub: string; count: number; valor: number;
  tone: 'base' | 'muted' | 'success' | 'danger';
  /** Facturado del período = 100% de la barra. `<= 0` → sin barra. */
  base: number;
}) {
  const valTone =
    tone === 'success' ? 'text-success'
    : tone === 'danger' ? 'text-danger'
    : tone === 'muted' ? 'text-muted-foreground'
    : 'text-foreground';
  // Sólo ancho de barra — ningún porcentaje nuevo se imprime en pantalla.
  const share = base > 0 ? (count / base) * 100 : null;
  const width = share === null || share <= 0 ? 0 : Math.max(2, Math.min(100, share));
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-foreground/90">
          {label} <span className="text-[10px] text-muted-foreground">· {sub}</span>
        </span>
        <span className="flex items-baseline gap-3 shrink-0 font-mono tabular-nums">
          <span className="text-xs font-bold text-foreground">{count.toLocaleString('es-CO')}</span>
          <span className={`text-xs w-28 text-right ${valTone}`}>{formatCOP(valor)}</span>
        </span>
      </div>
      {share !== null && (
        <div className="mt-1.5 h-1.5 rounded-full bg-foreground/10 overflow-hidden" aria-hidden="true">
          <div className={`h-full rounded-full ${CASCADA_BAR[tone]}`} style={{ width: `${width}%` }} />
        </div>
      )}
    </div>
  );
}

function SimRow({
  label, value, tone, sub,
}: { label: string; value: number; tone: 'base' | 'muted' | 'danger'; sub?: string }) {
  const isNeg = value < 0;
  const valTone = tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 py-2">
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
    <label className="block space-y-1.5">
      <span className="hud-label block">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-xl border border-border bg-card/40 px-2.5 py-1.5 text-xs font-mono tabular-nums transition-colors duration-200 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none focus:outline-none';

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
