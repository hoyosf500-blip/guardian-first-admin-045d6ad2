import { useEffect, useMemo, useRef, useState, type ElementType } from 'react';
import {
  Calculator, Truck, PackageCheck, Undo2, TrendingDown, Receipt, RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { formatCOP, getCurrencyCountry, paisUsaCentavos } from '@/lib/utils';
import {
  computeRealKpis, computeSimulation, type SimulationInput,
} from '@/lib/unitEconomics';
import type { LogisticsCostBasis } from '@/hooks/useLogisticsCostBasis';
import { useCostosUnitarios } from '@/hooks/useCostosUnitarios';
import { calcularCostosUnitarios } from '@/lib/costosUnitarios';

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
  pautaTotal: number;         // pautaEfectiva del padre: bitácora diaria O fallback mensual
  adminTotal: number;         // costos_admin
  /** true si pautaTotal viene de la bitácora DIARIA (ya acotada al rango) —
   *  en ese caso NO se prorratea. Mismo flag que usa NetoRealCard. */
  pautaFromDaily: boolean;
  // Rango activo — para prorratear pauta/admin (MENSUALES) a la ventana visible.
  fromDate: string;           // 'YYYY-MM-DD'
  toDate: string;             // 'YYYY-MM-DD'
  /** Filtro de ciudad activo — se reenvía a useCostosUnitarios para que el
   *  cargo por devolución cubra la misma población que el resto de los números. */
  ciudad?: string;
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
// "1.000.000" donde el punto es separador de miles). En EC (USD) y GT (GTQ) son
// con decimales: "6.49" debe ser 6.49, NO 649 — el punto/coma es decimal. Sin la
// rama GT, una tienda de Guatemala que escribía "45.50" obtenía 4550 (100× off).
function parseCop(v: string): number {
  if (paisUsaCentavos(getCurrencyCountry())) {
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
  costBasis, costBasisLoading, pautaTotal, adminTotal, pautaFromDaily,
  fromDate, toDate, ciudad,
}: Props) {
  // El admin es mensual; se prorratea al rango para que numerador (costo) y
  // denominador (ingresos del rango) cubran la misma ventana. La PAUTA solo se
  // prorratea cuando viene del fallback MENSUAL: desde e6b3234 (jul-2026)
  // `pautaTotal` suele ser la suma de la bitácora DIARIA, que YA cubre exacto
  // [fromDate,toDate] — prorratearla de nuevo la encogía dos veces (al día 23
  // del mes la publicidad entraba ×23/31) y la ganancia proyectada salía
  // inflada, contradiciendo a NetoRealCard en la misma pantalla (auditoría
  // 24-ago-2026).
  const fracMes = useMemo(() => fraccionMesCubierta(fromDate, toDate), [fromDate, toDate]);
  const pautaProrateada = pautaFromDaily ? pautaTotal : pautaTotal * fracMes;
  const adminProrateado = adminTotal * fracMes;
  // El admin (y la pauta de fallback) salen de UN solo mes (el de fromDate):
  // en rangos multi-mes se resta 1 mes de costo contra N meses de ingresos.
  // Hasta que se sumen los meses cubiertos, se dice en la cara.
  const rangoMultiMes = fromDate.slice(0, 7) !== toDate.slice(0, 7);
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
  // Cargo de devolución REAL (el que Dropi cobra aparte del flete), desde la
  // billetera. Solo se usa si la muestra cubre la mayoría de las devoluciones
  // del período — ver el comentario en el seed de abajo. Con la migración sin
  // aplicar o la billetera coja queda en 0 y el simulador avisa.
  const costosQ = useCostosUnitarios(fromDate, toDate, ciudad);
  const costosUnit = useMemo(() => calcularCostosUnitarios(costosQ.data), [costosQ.data]);
  const cargoDevolucionUnit =
    costosUnit?.cargoDevolucionConfiable && costosUnit.cargoPorDevolucion != null
      ? costosUnit.cargoPorDevolucion
      : 0;
  /** Hay devoluciones pero su cargo no se pudo medir → el margen sale optimista. */
  const cargoDevolucionIncompleto = Boolean(
    costosUnit && costosUnit.devueltos > 0 && !costosUnit.cargoDevolucionConfiable,
  );
  /**
   * ⛔ EL OTRO CASO, EL QUE NO SE AVISABA (4-sep-2026).
   *
   * La bandera de arriba cubre "la muestra del cargo es coja" y eso está bien
   * resuelto. Pero si la consulta de costos FALLA, `costosQ.data` es undefined,
   * `costosUnit` queda en null, esa bandera da `false` y el cargo por devolución
   * se pone en 0 SIN decir nada: el margen proyectado sale inflado y con cara de
   * medido. Se distingue de la carga a propósito — mientras viaja la consulta
   * `costosUnit` también es null, y avisar ahí sería un cartel en cada refresco.
   */
  const costosNoSeLeyeron = costosQ.isError && !costosQ.isLoading;

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
    // El contrato del campo (unitEconomics.ts) es "flete perdido + CARGO", y acá
    // se sembraba solo el flete: el cargo que Dropi cobra aparte por cada
    // devolución no entraba nunca. Medido en Colombia, julio 2026: 64
    // devoluciones × ~$22.000 = $1.408.000 de costo invisible en UN mes, y toda
    // la utilidad proyectada salía inflada por esa plata.
    //
    // Ahora se suma el cargo real de la billetera, PERO solo cuando hay datos
    // suficientes para creerle (`cargoDevolucionConfiable`): en Colombia la
    // billetera tiene el cargo de ~1 de cada 10 devoluciones, y un promedio sobre
    // 4 casos saltaba de $19.724 a $43.582 entre meses. Con la muestra coja se
    // mantiene solo el flete y el aviso de abajo dice que falta ese costo — un
    // número prudente y rotulado es mejor que uno inventado.
    costoDevolucionUnit: round2(fleteUnit + cargoDevolucionUnit),
  }), [generadosSinCancel, kpis, ingresosBase, cogs, flete, pautaProrateada, adminProrateado, fleteUnit, cargoDevolucionUnit]);

  const [sim, setSim] = useState<SimulationInput>(seed);
  /**
   * ⛔ NO PISAR LO QUE EL DUEÑO ESTÁ ESCRIBIENDO (4-sep-2026).
   *
   * `setSim(seed)` corría con CADA cambio de `seed`, y `seed` se rehace cuando
   * cambian los KPIs — o sea, con cada pedido nuevo que entra por realtime. El
   * dueño tecleaba un escenario ("¿y si subo el ticket un 10%?") y a mitad de
   * frase el simulador volvía a los números reales.
   *
   * ⚠️ Y NO se usa `dirty` para frenarlo: `dirty` es una comparación derivada
   * (`sim[k] !== seed[k]`), así que en cuanto se toca un campo queda en `true`
   * PARA SIEMPRE y el simulador no volvería a actualizarse nunca. Lo que hace
   * falta es una bandera explícita de "el usuario editó", que se limpia cuando
   * cambia el PERÍODO (ahí el escenario viejo ya no aplica) o cuando él mismo
   * pide restaurar.
   */
  const editadoRef = useRef(false);
  useEffect(() => {
    // Período nuevo: el escenario anterior habla de otros meses. Se re-siembra.
    editadoRef.current = false;
    setSim(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, ciudad]);
  useEffect(() => {
    if (editadoRef.current) return;
    setSim(seed);
  }, [seed]);

  const result = useMemo(() => computeSimulation(sim), [sim]);
  const dirty = useMemo(
    () => (Object.keys(seed) as (keyof SimulationInput)[]).some((k) => sim[k] !== seed[k]),
    [sim, seed],
  );

  const set = (patch: Partial<SimulationInput>) => {
    editadoRef.current = true;
    setSim((s) => ({ ...s, ...patch }));
  };
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
          hint={`${despachadosCount} de ${generadosSinCancel} generados salieron a la calle`} />
        <UnitKpi label="Tasa de entrega" value={pct1(kpis.tasaEntrega)} icon={PackageCheck} tone="success"
          hint={`${entregadosCount} de ${resueltos} que ya concluyeron · sin rechazos`} />
        <UnitKpi label="% Devolución" value={pct1(kpis.pctDevolucion)} icon={Undo2} tone="danger"
          hint={`${devueltosCount} de ${resueltos} que ya concluyeron · cuenta PEDIDOS, no plata`} />
        <UnitKpi label="% Rechazo" value={pct1(kpis.pctRechazo)} icon={Undo2} tone="warning"
          hint={`${rechazadosCount} rechazados / despachado`} />
        <UnitKpi label="% Inefectividad" value={pct1(kpis.pctInefectividad)} icon={TrendingDown} tone="warning"
          hint="no entregado / generado · incluye lo aún en camino: baja solo al madurar el mes" />
        <UnitKpi label="Ticket promedio" value={formatCOP(kpis.ticketPromedio)} icon={Receipt} tone="accent"
          hint="por pedido entregado" />
      </div>

      {/* El puente que faltaba: el dueño comparaba el "% Devolución" de acá
          (que cuenta PEDIDOS) con los % de plata de Finanzas y creía que uno
          mentía (23-ago-2026). Miden cosas distintas y se dice. */}
      <p className="px-4 pb-1 text-[10px] text-muted-foreground leading-relaxed">
        Estos indicadores cuentan <strong className="text-foreground/80">pedidos</strong> (de cada 100 que
        concluyeron, cuántos volvieron). Los % de la pestaña{' '}
        <strong className="text-foreground/80">Finanzas</strong> miden{' '}
        <strong className="text-foreground/80">plata</strong> sobre ventas — por eso allá la devolución
        da un % más chico y los dos están bien.
      </p>

      {/* Cascada real — ahora con barra proporcional sobre el facturado (la base
          del embudo), igual que el embudo de MesActualResumen. La barra no
          agrega ningún número a la pantalla: es el mismo `count` de la fila
          medido contra la primera fila. Sin base (`generadosSinCancel <= 0`) no
          se dibuja ninguna barra: no habría contra qué proporcionar. */}
      <div className="px-4 pb-4">
        <div className="rounded-2xl border border-border bg-muted/10 divide-y divide-border shadow-card3d">
          {/* `totalVendido` acá es el facturadoValor coherente del padre (todo lo
              no cancelado) — NO el tile "Total vendido" Dropi-parity. Ver el
              comentario de facturadoValor en MesActualResumen. */}
          <CascadaRow label="Facturado" sub="todo lo pedido sin cancelar" count={generadosSinCancel} valor={totalVendido} tone="base" base={generadosSinCancel} />
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
              onClick={() => { editadoRef.current = false; setSim(seed); }}
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

        {/* La consulta de costos FALLÓ. Distinto del caso de abajo (muestra coja):
            acá no sabemos nada, y el cargo por devolución entra en 0 — o sea que
            el margen proyectado sale inflado sin que nada lo diga. */}
        {costosNoSeLeyeron && (
          <div className="relative flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d">
            <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-warning/20 glow-warning">
              <AlertTriangle size={17} className="text-warning" aria-hidden="true" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed flex-1 min-w-0">
              No se pudieron leer los costos unitarios, así que el <strong>cargo por
              devolución entra en $0</strong> y la ganancia que ves acá abajo está
              INFLADA. No es que no haya costo: es que no se pudo medir. Recargá
              antes de tomar una decisión con este número.
            </p>
          </div>
        )}

        {/* Hay devoluciones pero su CARGO no se pudo medir. El "Costo devol." de
            abajo trae solo el flete perdido, así que la utilidad sale OPTIMISTA.
            Se dice en vez de dejar creer que el costo está completo. */}
        {cargoDevolucionIncompleto && (
          <div className="relative flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d">
            <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-warning/20 glow-warning">
              <AlertTriangle size={17} className="text-warning" aria-hidden="true" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed flex-1 min-w-0">
              El <strong className="text-foreground">costo por devolución</strong> de acá abajo trae
              solo el flete perdido. Dropi cobra su cargo cuando el paquete vuelve al origen, y del
              período todavía facturó{' '}
              <strong className="text-foreground">
                {costosUnit?.devolucionesCobradas ?? 0} de {costosUnit?.devueltos ?? 0}
              </strong>{' '}
              devoluciones. La utilidad que ves es <strong className="text-foreground">optimista</strong>:
              cuando Dropi termine de facturar va a bajar. Podés tipear el cargo a mano en “Costo devol.”.
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

        {rangoMultiMes && (
          <p className="text-[10px] text-warning/90 leading-relaxed">
            El rango cruza varios meses: <strong>Admin</strong>
            {pautaFromDaily ? '' : ' y Publicidad'} solo traen lo guardado para{' '}
            <span className="font-mono">{fromDate.slice(0, 7)}</span> — con 3 meses de
            ingresos, ese costo queda subcontado y la ganancia proyectada sale optimista.
          </p>
        )}

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

// CopField/PctField llevan TEXTO local (mismo patrón que CostInput de
// NetoRealCard): si el input mostrara String(value) directo, al tipear "45."
// el parse devuelve 45, el padre re-renderiza y el punto desaparece antes de
// poder escribir los centavos — en EC/GT (decimales) "32.48" era intipeable.
// Solo se resiembra cuando el valor cambia desde AFUERA (re-seed del mes o
// "Restaurar reales"), nunca como eco del propio tipeo.
function CopField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(value === 0 ? '' : String(value));
  useEffect(() => {
    if (parseCop(text) !== value) setText(value === 0 ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <FieldShell label={label}>
      <input
        type="text" inputMode="decimal"
        value={text} placeholder="$0"
        onChange={(e) => { setText(e.target.value); onChange(parseCop(e.target.value)); }}
        className={inputCls}
      />
    </FieldShell>
  );
}

function PctField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  // value es 0-1; el texto muestra el % con hasta 1 decimal, sin ceros colgando.
  const fromValue = (v: number) => (v === 0 ? '' : String(Math.round(v * 1000) / 10));
  const [text, setText] = useState(fromValue(value));
  useEffect(() => {
    if (parsePct(text) !== value) setText(fromValue(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <FieldShell label={`${label} %`}>
      <input
        type="text" inputMode="decimal"
        value={text} placeholder="0"
        onChange={(e) => { setText(e.target.value); onChange(parsePct(e.target.value)); }}
        className={inputCls}
      />
    </FieldShell>
  );
}
