import { Skeleton } from '@/components/ui/skeleton';
import { useFinancialSummary } from '@/hooks/useFinancialSummary';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { formatCOP } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, DollarSign, Truck, RotateCcw,
  Target, Package, CheckCircle2, AlertTriangle, Receipt, Wallet, Info,
  Ban, Sparkles,
} from 'lucide-react';

// Fase A del módulo financiero — utilidad bruta operativa.
//
// Diseño: 6 KPI cards principales (utilidad bruta destacada, luego ingresos,
// COGS, flete combinado, costo devoluciones, tasa entrega), card secundaria
// con tickets / órdenes, y card opcional con wallet neto. Mismo estilo
// visual que BilleteraTab (rounded-xl, bg-card, tipografía tabular-nums).
//
// IMPORTANTE: el banner informativo arriba comunica explícitamente que NO
// incluye gasto pauta. Ese es el principal disclaimer que el cliente
// confirmó — Fase B sumará Meta/TikTok cuando se conecte el token.

type Tone = 'success' | 'danger' | 'info' | 'warning' | 'neutral';

function toneClasses(tone: Tone) {
  switch (tone) {
    case 'success': return 'text-success';
    case 'danger':  return 'text-danger';
    case 'info':    return 'text-info';
    case 'warning': return 'text-warning';
    default:        return 'text-foreground';
  }
}

interface KpiCardProps {
  label: string;
  value: string;
  icon: React.ElementType;
  tone: Tone;
  hint?: string;
  big?: boolean;
}

function KpiCard({ label, value, icon: Icon, tone, hint, big = false }: KpiCardProps) {
  const colorClass = toneClasses(tone);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
          {label}
        </span>
        <Icon size={14} className={colorClass} aria-hidden="true" />
      </div>
      <div
        className={`mt-2 font-bold tabular-nums ${colorClass} ${
          big ? 'text-3xl sm:text-4xl' : 'text-xl'
        }`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

export default function FinanzasTab({ filters }: { filters: LogisticsFilters }) {
  const { fromDate, toDate } = filters;
  const { data, isLoading, isError, error } = useFinancialSummary(fromDate, toDate);

  if (isError) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/5 p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-danger shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-danger">No pudimos cargar las finanzas</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {(error as Error)?.message ?? 'Error desconocido'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const fleteCombinado = (data?.flete_entregadas ?? 0) + (data?.flete_devoluciones ?? 0);
  const utilidad = data?.utilidad_bruta ?? 0;
  const utilidadTone: Tone = utilidad >= 0 ? 'success' : 'danger';
  const utilidadIcon = utilidad >= 0 ? TrendingUp : TrendingDown;

  return (
    <div className="space-y-4">
      {/* Banner informativo — fase A sin gasto pauta */}
      <div className="rounded-xl border border-info/30 bg-info/5 p-4">
        <div className="flex items-start gap-3">
          <Info size={16} className="text-info shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              Fase A — Utilidad bruta operativa
            </h3>
            <p className="text-xs text-muted-foreground">
              Calculamos ingresos − COGS − flete (entregadas + devoluciones) − costo devoluciones.
              <strong className="text-foreground"> NO incluye gasto de pauta</strong> (Meta / TikTok).
              Cuando conectemos Meta Ads en Fase B, sumamos publicidad para ROAS real.
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <>
          <div className="grid grid-cols-1">
            <Skeleton className="h-[120px] rounded-xl" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[100px] rounded-xl" />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Utilidad bruta destacada (full-width) */}
          <div className="grid grid-cols-1">
            <KpiCard
              label="Utilidad bruta del período"
              value={formatCOP(utilidad)}
              icon={utilidadIcon}
              tone={utilidadTone}
              big
              hint={
                utilidad >= 0
                  ? 'Ingresos cubren COGS, flete y devoluciones — operación rentable (sin pauta)'
                  : 'Operación en pérdida sin contar pauta — revisá COGS, flete o tasa de devolución'
              }
            />
          </div>

          {/* KPIs principales — 8 cards (2x4 en lg) */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard
              label="Ingresos brutos"
              value={formatCOP(data?.ingresos_brutos ?? 0)}
              icon={DollarSign}
              tone="info"
              hint="Solo pedidos entregados"
            />
            <KpiCard
              label="COGS (costo producto)"
              value={formatCOP(data?.cogs ?? 0)}
              icon={Package}
              tone="warning"
              hint="Suma de supplier_price"
            />
            <KpiCard
              label="Flete (entregados + devs.)"
              value={formatCOP(fleteCombinado)}
              icon={Truck}
              tone="warning"
              hint={`Entregadas: ${formatCOP(data?.flete_entregadas ?? 0)} · Devs: ${formatCOP(data?.flete_devoluciones ?? 0)}`}
            />
            {/* Card: Pérdida total por devoluciones (flete ida + cargo extra Dropi).
                Reemplazó a "Costo devoluciones" — la card vieja solo mostraba
                el cargo extra Dropi (~$65k) sin el flete de ida perdido (~$4.5M).
                Total real = flete_devoluciones + costo_devoluciones. */}
            <KpiCard
              label="Pérdida por devoluciones"
              value={formatCOP(data?.perdida_total_devoluciones ?? 0)}
              icon={RotateCcw}
              tone="danger"
              hint={`${data?.total_devueltas ?? 0} devs — promedio ${formatCOP(data?.costo_promedio_devolucion ?? 0)} c/u`}
            />
            <KpiCard
              label="Cancelados"
              value={formatCOP(data?.valor_cancelado ?? 0)}
              icon={Ban}
              tone="danger"
              hint={`${data?.total_cancelados ?? 0} órdenes (${(data?.tasa_cancelacion_pct ?? 0).toFixed(1)}%) — valor potencial perdido`}
            />
            <KpiCard
              label="Ganancia markup"
              value={formatCOP(data?.ganancia_markup ?? 0)}
              icon={Sparkles}
              tone="success"
              hint="Informativo — pendiente sanity check para sumar a utilidad"
            />
            <KpiCard
              label="Tasa de entrega"
              value={`${(data?.tasa_entrega_pct ?? 0).toFixed(1)}%`}
              icon={Target}
              tone={(data?.tasa_entrega_pct ?? 0) >= 60 ? 'success' : 'warning'}
              hint={`${data?.total_entregadas ?? 0} de ${data?.total_ordenes ?? 0} órdenes`}
            />
            <KpiCard
              label="Ticket promedio"
              value={formatCOP(data?.ticket_promedio ?? 0)}
              icon={Receipt}
              tone="info"
              hint="Promedio por pedido entregado"
            />
          </div>

          {/* Mini-info: desglose flete de ida vs cargo extra Dropi.
              Justo debajo del grid principal — explica de qué se compone la card
              "Pérdida por devoluciones". */}
          <div className="text-xs text-muted-foreground italic">
            Pérdida devoluciones = Flete de ida ({formatCOP(data?.flete_devoluciones ?? 0)}) + Cargo extra Dropi ({formatCOP(data?.costo_devoluciones ?? 0)})
          </div>

          {/* Disclaimer ganancia_markup — todavía NO suma a utilidad bruta */}
          <div className="text-xs text-muted-foreground italic">
            Nota: <strong>Ganancia Markup</strong> aparece como referencia. Aún no se suma a la utilidad bruta hasta confirmar (con sanity check) que no genera doble conteo con `cobro_entrega`. Una vez confirmado, lo sumamos.
          </div>

          {/* Card secundaria — conteo de tickets */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-bold text-foreground tracking-tight uppercase tracking-[0.06em] mb-3">
              Volumen de operación
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  <Package size={12} aria-hidden="true" />
                  Órdenes totales
                </div>
                <div className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                  {data?.total_ordenes ?? 0}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  <CheckCircle2 size={12} className="text-success" aria-hidden="true" />
                  Entregadas
                </div>
                <div className="mt-1 text-2xl font-bold tabular-nums text-success">
                  {data?.total_entregadas ?? 0}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  <RotateCcw size={12} className="text-danger" aria-hidden="true" />
                  Devueltas
                </div>
                <div className="mt-1 text-2xl font-bold tabular-nums text-danger">
                  {data?.total_devueltas ?? 0}
                </div>
              </div>
            </div>
          </div>

          {/* Wallet neto informativo */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-muted/40 flex items-center justify-center">
                  <Wallet size={16} className="text-foreground" aria-hidden="true" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-foreground">Wallet neto del período</div>
                  <div className="text-[11px] text-muted-foreground">
                    Entradas − salidas en la billetera Dropi (informativo, no entra en utilidad bruta).
                  </div>
                </div>
              </div>
              <div
                className={`text-xl font-bold tabular-nums shrink-0 ${
                  (data?.wallet_neto ?? 0) >= 0 ? 'text-success' : 'text-danger'
                }`}
              >
                {formatCOP(data?.wallet_neto ?? 0)}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
