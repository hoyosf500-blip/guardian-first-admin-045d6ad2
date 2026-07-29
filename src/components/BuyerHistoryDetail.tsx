import { useState } from 'react';
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

/** Fila entr/dev/tráns con los colores semánticos del CRM (verde/rojo/muted). */
function StatTriple({ delivered, returned, transit }: { delivered: number; returned: number; transit: number }) {
  return (
    <span className="flex items-center gap-2 tabular-nums shrink-0 text-[11px]">
      <span className="text-success font-semibold">{delivered} entr</span>
      <span className="text-danger font-semibold">{returned} dev</span>
      <span className="text-muted-foreground">{transit} tráns</span>
    </span>
  );
}

function SectionHeader({ icon: Icon, label }: { icon: typeof Truck; label: string }) {
  return (
    <div className="flex items-center gap-1.5 mt-3 mb-1.5 first:mt-0">
      <Icon size={11} className="text-accent" aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
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
        <div className="mt-2.5 space-y-1">
          {/* Alerta cross-tienda: qué hizo el cliente con OTRAS tiendas. */}
          {otras && (
            <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5">
              <AlertTriangle size={12} className="text-warning shrink-0" aria-hidden="true" />
              <span className="text-[11px] font-semibold text-foreground">Con otras tiendas:</span>
              <StatTriple delivered={otras.delivered} returned={otras.returned} transit={otras.transit} />
            </div>
          )}

          {/* Por transportadora — sobre todas las tiendas, la más usada primero. */}
          {couriers.length > 0 && (
            <>
              <SectionHeader icon={Truck} label="Por transportadora" />
              <ul className="space-y-1">
                {couriers.map((c) => (
                  <li key={c.courierId} className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-[11px] font-medium text-foreground truncate">
                      {courierName(countryCode, c.courierId)}
                    </span>
                    <StatTriple delivered={c.delivered} returned={c.returned} transit={c.transit} />
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Por rango de precio. */}
          {all.byPrice.length > 0 && (
            <>
              <SectionHeader icon={DollarSign} label="Por precio" />
              <ul className="space-y-1">
                {all.byPrice.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-[11px] font-medium text-foreground truncate">{p.label}</span>
                    <StatTriple delivered={p.delivered} returned={p.returned} transit={p.transit} />
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Contra entrega. */}
          {all.byPayment.some((p) => p.isCod) && (
            <>
              <SectionHeader icon={Wallet} label="Contra entrega" />
              {all.byPayment.filter((p) => p.isCod).map((p, i) => (
                <div key={i} className="flex items-center justify-end">
                  <StatTriple delivered={p.delivered} returned={p.returned} transit={p.transit} />
                </div>
              ))}
            </>
          )}

          <p className="pt-2 text-[9px] text-muted-foreground/70 uppercase tracking-wider">
            Todas las tiendas Dropi · datos del comprador
          </p>
        </div>
      )}
    </div>
  );
}
