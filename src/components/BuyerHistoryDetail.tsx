import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Truck, DollarSign, Wallet, AlertTriangle } from 'lucide-react';
import {
  type BuyerContext, otherShopsSummary, sortCouriersByVolume,
} from '@/lib/buyerHistory';
import { courierName } from '@/lib/dropiCouriers';

/**
 * Detalle expandible del historial del comprador (huella Dropi), debajo de la
 * tarjeta compacta en Confirmar. La asesora abre "Ver más" y ve, sobre TODAS
 * las tiendas, cómo le fue a este cliente por transportadora, por precio y en
 * contra entrega — más una alerta de qué hizo con OTRAS tiendas.
 *
 * Los datos ya llegan en la huella (`fingerprint.context_analysis`); acá solo
 * se dibujan. Ver `src/lib/buyerHistory.ts`.
 */

/**
 * Celda numérica de ancho fijo. Los CEROS se atenúan a propósito: así el ojo va
 * directo al dato que importa (una devolución, un pedido en tránsito) en vez de
 * ahogarse en una pared de "0 0 0". Entregado=verde, devuelto=rojo, tránsito=muted.
 */
function Num({ value, tone }: { value: number; tone: string }) {
  return (
    <span
      className={`w-9 shrink-0 text-right tabular-nums text-[11px] font-semibold ${
        value === 0 ? 'text-muted-foreground/40' : tone
      }`}
    >
      {value}
    </span>
  );
}

/** Las tres métricas como columnas fijas → alinean verticalmente fila a fila. */
function Metrics({ delivered, returned, transit }: { delivered: number; returned: number; transit: number }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Num value={delivered} tone="text-success" />
      <Num value={returned} tone="text-danger" />
      <Num value={transit} tone="text-muted-foreground" />
    </div>
  );
}

/** Encabezado de columnas (Entr / Dev / Trán), una sola vez arriba de las filas. */
function ColHeader() {
  return (
    <div className="flex items-center justify-end gap-1.5 pb-1.5">
      {['Entr', 'Dev', 'Trán'].map((h) => (
        <span
          key={h}
          className="w-9 shrink-0 text-right text-[9px] font-bold uppercase tracking-wide text-muted-foreground/70"
        >
          {h}
        </span>
      ))}
    </div>
  );
}

/** Sección con icono, título y una línea fina que la separa visualmente. */
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

function DataRow({ label, tag, delivered, returned, transit }: {
  label: string; tag?: string; delivered: number; returned: number; transit: number;
}) {
  return (
    <div className="flex items-center gap-2 py-[3px]">
      <span className="flex-1 min-w-0 truncate text-[11px] font-medium text-foreground">
        {label}
        {tag && (
          <span className="ml-1.5 text-[9px] font-normal uppercase tracking-wide text-muted-foreground/70">{tag}</span>
        )}
      </span>
      <Metrics delivered={delivered} returned={returned} transit={transit} />
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

  return (
    <div className="px-4 pb-3 pt-1 border-t border-border/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
      >
        {open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        {open ? 'Ver menos' : 'Ver historial detallado'}
      </button>

      {open && (
        <div className="mt-2.5">
          {/* Alerta cross-tienda: qué hizo el cliente con OTRAS tiendas — el
              riesgo que nuestro CRM solo no puede ver. Va resaltada en ámbar. */}
          {otras && (
            <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 mb-1.5">
              <AlertTriangle size={13} className="text-warning shrink-0" aria-hidden="true" />
              <span className="flex-1 min-w-0 text-[11px] font-semibold text-foreground">Con otras tiendas:</span>
              <Metrics delivered={otras.delivered} returned={otras.returned} transit={otras.transit} />
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
