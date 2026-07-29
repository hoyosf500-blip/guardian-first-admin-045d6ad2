import { useState, type ReactNode } from 'react';
import {
  ChevronDown, ChevronUp, Truck, DollarSign, Wallet, AlertTriangle, Store,
  CheckCircle2, RotateCcw,
} from 'lucide-react';
import {
  type BuyerContext, otherShopsSummary, sortCouriersByVolume,
} from '@/lib/buyerHistory';
import { courierName } from '@/lib/dropiCouriers';

/**
 * Detalle expandible del historial del comprador (huella Dropi), debajo de la
 * tarjeta compacta en Confirmar. La asesora abre "Ver más" y ve, sobre TODAS
 * las tiendas, cómo le fue a este cliente por transportadora, por precio y en
 * contra entrega — más una alerta de qué hizo con OTRAS tiendas, dejando claro
 * si esos pedidos siguen EN CAMINO (activos = riesgo COD) o ya se entregaron.
 *
 * Los datos ya llegan en la huella (`fingerprint.context_analysis`); acá solo
 * se dibujan. Ver `src/lib/buyerHistory.ts`.
 *
 * Lenguaje visual = el de la tarjeta compacta: entregado verde + CheckCircle2,
 * devuelto rojo + RotateCcw, en camino ámbar + Truck, barras de proporción.
 */

const plural = (n: number, uno: string, muchos: string) => `${n} ${n === 1 ? uno : muchos}`;

/** Chip con PALABRA (no número suelto): "2 en camino", "4 entregados"… Se
 *  apaga cuando el conteo es 0 para que el dato real salte a la vista. */
function WordChip({ count, text, tone }: {
  count: number;
  text: string;
  tone: 'success' | 'danger' | 'warning';
}) {
  const on: Record<string, string> = {
    success: 'border-success/40 bg-success/15 text-success',
    danger: 'border-danger/40 bg-danger/15 text-danger',
    warning: 'border-warning/40 bg-warning/15 text-warning',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${
        count === 0 ? 'border-border bg-muted/30 text-muted-foreground/50' : on[tone]
      }`}
    >
      {text}
    </span>
  );
}

/** Celda numérica de ancho fijo → las tres columnas alinean fila a fila.
 *  Los ceros se atenúan a propósito (en /50 — la única variante alfa cubierta
 *  por el bloque COMPATIBILIDAD TEMA CLARO de index.css; /40 era invisible en
 *  claro). El aria-label da la semántica que el layout visual pone en el
 *  encabezado de iconos ("6" solo no dice nada a un lector de pantalla). */
function Num({ value, tone, label }: { value: number; tone: string; label: string }) {
  return (
    <span
      aria-label={`${value} ${label}`}
      className={`w-8 shrink-0 text-right tabular-nums text-[11px] font-semibold ${
        value === 0 ? 'text-muted-foreground/50' : tone
      }`}
    >
      {value}
    </span>
  );
}

function Metrics({ delivered, returned, transit }: { delivered: number; returned: number; transit: number }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Num value={delivered} tone="text-success" label="entregados" />
      <Num value={returned} tone="text-danger" label="devueltos" />
      <Num value={transit} tone="text-warning" label="en camino" />
    </div>
  );
}

/** Encabezado de columnas con los MISMOS iconos de la tarjeta compacta —
 *  verde entregado / rojo devuelto / ámbar en camino. */
function ColHeader() {
  const cols: Array<{ icon: typeof CheckCircle2; tone: string; label: string }> = [
    { icon: CheckCircle2, tone: 'text-success', label: 'Entregados' },
    { icon: RotateCcw, tone: 'text-danger', label: 'Devueltos' },
    { icon: Truck, tone: 'text-warning', label: 'En camino' },
  ];
  return (
    <div className="flex items-center justify-end gap-1.5 pb-1">
      {cols.map(({ icon: Icon, tone, label }) => (
        <span key={label} className="w-8 flex justify-end" role="img" aria-label={label} title={label}>
          <Icon size={11} className={tone} aria-hidden="true" />
        </span>
      ))}
    </div>
  );
}

function Section({ icon: Icon, label, children }: { icon: typeof Truck; label: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={11} className="text-accent shrink-0" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="flex-1 h-px bg-border/40" aria-hidden="true" />
      </div>
      {children}
    </div>
  );
}

/** Fila de datos: label + columnas alineadas + mini barra de proporción
 *  (verde/rojo/ámbar) — la misma gramática que las barras de la tarjeta. */
function DataRow({ label, tag, delivered, returned, transit }: {
  label: string; tag?: string; delivered: number; returned: number; transit: number;
}) {
  const total = delivered + returned + transit;
  const pct = (v: number) => (total > 0 ? `${(v / total) * 100}%` : '0%');
  const seg = (v: number) => ({ width: pct(v), minWidth: v > 0 ? '6px' : '0' });
  return (
    <div className="py-1">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[11px] font-medium text-foreground">
          {label}
          {tag && (
            <span className="ml-1.5 text-[9px] font-normal uppercase tracking-wide text-muted-foreground/70">{tag}</span>
          )}
        </span>
        <Metrics delivered={delivered} returned={returned} transit={transit} />
      </div>
      {total > 0 && (
        <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted/60" aria-hidden="true">
          <div className="bg-success transition-[width] duration-500 motion-reduce:transition-none" style={seg(delivered)} />
          <div className="bg-danger transition-[width] duration-500 motion-reduce:transition-none" style={seg(returned)} />
          <div className="bg-warning transition-[width] duration-500 motion-reduce:transition-none" style={seg(transit)} />
        </div>
      )}
    </div>
  );
}

export default function BuyerHistoryDetail({
  context,
  countryCode,
}: {
  context: BuyerContext;
  countryCode: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const all = context.allShops;
  const otras = otherShopsSummary(context);
  const couriers = sortCouriersByVolume(all.byCourier);
  const hasCod = all.byPayment.some((p) => p.isCod);
  const hasRows = couriers.length > 0 || all.byPrice.length > 0 || hasCod;
  // Pedidos ACTIVOS con otras tiendas = el riesgo COD que el CRM solo no ve:
  // si ya tiene 2 contraentregas en camino, la 3ra tiene más chance de rechazo.
  const otrasActivos = (otras?.transit ?? 0) > 0;

  return (
    <div className="px-4 pb-3 pt-1 border-t border-border/60">
      {/* min-h-11 = 44px táctiles, la convención del proyecto (CallView). */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full cursor-pointer items-center gap-1 text-[11px] font-semibold text-accent transition-colors hover:underline active:opacity-80"
      >
        {open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        {open ? 'Ver menos' : 'Ver historial detallado'}
      </button>

      {open && (
        <div className="mt-2.5 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          {/* Con OTRAS tiendas: chips con palabras. "En camino" = pedidos
              ACTIVOS ahora — si hay, el panel entero escala a ámbar. */}
          {otras && (
            <div
              data-testid="otras-tiendas-panel"
              className={`rounded-lg border px-3 py-2 mb-1.5 ${
                otrasActivos ? 'border-warning/40 bg-warning/10' : 'border-border bg-surface/40'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1.5">
                {otrasActivos ? (
                  <AlertTriangle size={12} className="text-warning shrink-0" aria-hidden="true" />
                ) : (
                  <Store size={12} className="text-muted-foreground shrink-0" aria-hidden="true" />
                )}
                <span className="text-[11px] font-semibold text-foreground">Con otras tiendas:</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <WordChip count={otras.transit} text={`${otras.transit} en camino`} tone="warning" />
                <WordChip count={otras.delivered} text={plural(otras.delivered, 'entregado', 'entregados')} tone="success" />
                <WordChip count={otras.returned} text={plural(otras.returned, 'devuelto', 'devueltos')} tone="danger" />
              </div>
            </div>
          )}

          {hasRows && <ColHeader />}

          {/* Por transportadora — sobre todas las tiendas, la más usada primero. */}
          {couriers.length > 0 && (
            <Section icon={Truck} label="Por transportadora">
              {couriers.map((c, i) => (
                <DataRow
                  key={c.courierId}
                  label={courierName(countryCode, c.courierId)}
                  tag={i === 0 && couriers.length > 1 ? 'más usada' : undefined}
                  delivered={c.delivered}
                  returned={c.returned}
                  transit={c.transit}
                />
              ))}
            </Section>
          )}

          {/* Por rango de precio. */}
          {all.byPrice.length > 0 && (
            <Section icon={DollarSign} label="Por precio">
              {all.byPrice.map((p, i) => (
                <DataRow key={i} label={p.label} delivered={p.delivered} returned={p.returned} transit={p.transit} />
              ))}
            </Section>
          )}

          {/* Contra entrega. */}
          {hasCod && (
            <Section icon={Wallet} label="Contra entrega">
              {all.byPayment.filter((p) => p.isCod).map((p, i) => (
                <DataRow
                  key={i}
                  label="Pago contra entrega"
                  delivered={p.delivered}
                  returned={p.returned}
                  transit={p.transit}
                />
              ))}
            </Section>
          )}

          <p className="pt-2.5 mt-2.5 text-[9px] text-muted-foreground/70 uppercase tracking-wider border-t border-border/40">
            Todas las tiendas Dropi · datos del comprador
          </p>
        </div>
      )}
    </div>
  );
}
