import { useState, type ReactNode } from 'react';
import {
  ChevronDown, ChevronUp, Truck, DollarSign, Wallet, AlertTriangle, Store,
} from 'lucide-react';
import {
  type BuyerContext, otherShopsSummary, sortCouriersByVolume,
} from '@/lib/buyerHistory';
import { courierName } from '@/lib/dropiCouriers';
import { carrierLogo } from '@/lib/carrierLogos';

/**
 * Detalle expandible del historial del comprador (huella Dropi), debajo de la
 * tarjeta compacta en Confirmar. Lenguaje visual calcado del "Historial del
 * comprador" del panel de Dropi — que la asesora ya conoce:
 *
 *  - Resumen arriba: mini barras horizontales En tránsito / Devoluciones /
 *    Entregas con el valor al lado (patrón AAA: etiqueta + valor siempre
 *    visibles, ordenado por semántica fija).
 *  - Por transportadora: avatar tipo logo (iniciales con color estable por
 *    nombre) + pastillas con PALABRAS: "1 en tránsito / 2 devoluciones /
 *    6 entregas". Los ceros van atenuados para que el dato real salte.
 *  - "Con otras tiendas" escala a ámbar cuando hay pedidos EN TRÁNSITO
 *    (activos = riesgo COD que el CRM solo no puede ver).
 *
 * Los datos ya llegan en la huella (`fingerprint.context_analysis`); acá solo
 * se dibujan. Ver `src/lib/buyerHistory.ts`.
 */

/**
 * Un dato de la fila: distinto de cero → PASTILLA de color; cero → NADA.
 * Antes los ceros iban como texto apagado, pero siete "0 en tránsito · 0
 * entregas" repetidos seguían siendo ruido: el resumen de arriba ya declara
 * los ceros con etiqueta, así que en las filas solo habla lo que existe.
 */
function Stat({ count, uno, muchos, tone }: {
  count: number;
  uno: string;
  muchos: string;
  tone: 'success' | 'danger' | 'warning';
}) {
  if (count === 0) return null;
  const on: Record<string, string> = {
    success: 'border-success/40 bg-success/15 text-success',
    danger: 'border-danger/40 bg-danger/15 text-danger',
    warning: 'border-warning/40 bg-warning/15 text-warning',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap tabular-nums ${on[tone]}`}>
      {count} {count === 1 ? uno : muchos}
    </span>
  );
}

/** Los datos en el orden del panel de Dropi: tránsito → devoluciones →
 *  entregas. Fila sin nada distinto de cero → un guion apagado (no vacío). */
function PillRow({ delivered, returned, transit }: { delivered: number; returned: number; transit: number }) {
  if (delivered + returned + transit === 0) {
    return <span className="text-[10px] text-muted-foreground/70">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
      <Stat count={transit} uno="en tránsito" muchos="en tránsito" tone="warning" />
      <Stat count={returned} uno="devolución" muchos="devoluciones" tone="danger" />
      <Stat count={delivered} uno="entrega" muchos="entregas" tone="success" />
    </div>
  );
}

/**
 * Badge de transportadora: LOGO REAL empaquetado si lo tenemos
 * (src/lib/carrierLogos.ts) — círculo blanco para marcas transparentes,
 * relleno completo para íconos cuadrados, chip ancho para wordmarks. Sin
 * logo (VELOCES, CO sin resolver) o si la imagen falla → iniciales sobre un
 * color ESTABLE por nombre. Paleta CURADA: ≥4.5:1 con texto blanco.
 */
const AVATAR_COLORS = [
  '#4F46E5', // indigo
  '#0369A1', // sky oscuro
  '#047857', // emerald oscuro
  '#B91C1C', // rojo oscuro
  '#6D28D9', // violeta
  '#BE185D', // rosa oscuro
  '#C2410C', // naranja oscuro
  '#0F766E', // teal oscuro
];

function CarrierAvatar({ name }: { name: string }) {
  const [broken, setBroken] = useState(false);
  const logo = carrierLogo(name);

  if (logo && !broken) {
    if (logo.fit === 'wide') {
      // Wordmark horizontal (Laar): chip redondeado ancho sobre blanco.
      return (
        <span aria-hidden="true" className="flex h-6 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white px-1 ring-1 ring-border">
          <img src={logo.src} alt="" loading="lazy" className="max-h-4 w-full object-contain" onError={() => setBroken(true)} />
        </span>
      );
    }
    return (
      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white ring-1 ring-border">
        <img
          src={logo.src}
          alt=""
          loading="lazy"
          className={logo.fit === 'cover' ? 'h-full w-full object-cover' : 'h-5 w-5 object-contain'}
          onError={() => setBroken(true)}
        />
      </span>
    );
  }

  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const initials = (words.length >= 2 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ring-1 ring-border"
      style={{ backgroundColor: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] }}
    >
      {initials}
    </span>
  );
}

/** Mini barra horizontal del resumen: etiqueta + barra proporcional + valor
 *  SIEMPRE visible al lado (nunca solo color). */
function SummaryBar({ label, value, max, fill, valueTone }: {
  label: string; value: number; max: number; fill: string; valueTone: string;
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0;
  // Track: bg-muted SÓLIDO + borde — el mismo trato que las barras de tasa de
  // FingerprintBadge, 20px arriba en la misma tarjeta. bg-muted/60 no está
  // remapeado por el bloque de tema claro y desaparecía sobre blanco.
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[10px] font-semibold text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted border border-border" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${fill}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`w-7 shrink-0 text-right text-[11px] font-bold tabular-nums ${value === 0 ? 'text-muted-foreground/70' : valueTone}`}>
        {value}
      </span>
    </div>
  );
}

function Section({ icon: Icon, label, count, children }: {
  icon: typeof Truck; label: string; count?: number; children: ReactNode;
}) {
  return (
    <div className="mt-3.5 first:mt-0">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={11} className="text-accent shrink-0" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        {/* Cuántas hay, de un vistazo — antes había que contarlas a ojo. */}
        {typeof count === 'number' && count > 1 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border bg-muted/50 px-1 text-[9px] font-bold tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        <span className="flex-1 h-px bg-border/40" aria-hidden="true" />
      </div>
      {children}
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
  const cod = all.byPayment.filter((p) => p.isCod);
  // Pedidos ACTIVOS con otras tiendas = el riesgo COD que el CRM solo no ve.
  const otrasActivos = (otras?.transit ?? 0) > 0;
  // Resumen solo si el desglose global trae algo (huellas viejas vienen sin él).
  const resumenTotal = all.delivered + all.returned + all.transit;
  const resumenMax = Math.max(all.delivered, all.returned, all.transit);

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
        <div className="mt-1.5 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          {/* Resumen — mismo mini bar chart del panel de Dropi. Son cifras del
              PERÍODO de análisis de Dropi, NO el histórico de vida que muestra
              el grid grande de arriba: sin este rótulo la asesora veía números
              "contradictorios" a 40px de distancia y desconfiaba de la huella. */}
          {resumenTotal > 0 && (
            <div className="mb-2.5 space-y-1.5 rounded-lg border border-border bg-surface/40 px-3 py-2.5">
              <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70">
                Período de análisis Dropi · todas las tiendas
              </p>
              <SummaryBar label="En tránsito" value={all.transit} max={resumenMax} fill="bg-warning" valueTone="text-warning" />
              <SummaryBar label="Devoluciones" value={all.returned} max={resumenMax} fill="bg-danger" valueTone="text-danger" />
              <SummaryBar label="Entregas" value={all.delivered} max={resumenMax} fill="bg-success" valueTone="text-success" />
            </div>
          )}

          {/* Con OTRAS tiendas: si hay pedidos EN TRÁNSITO el panel escala a ámbar. */}
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
              <PillRow delivered={otras.delivered} returned={otras.returned} transit={otras.transit} />
            </div>
          )}

          {/* Por transportadora — la más usada primero, con "logo" estable.
              UNA línea por transportadora (nombre izquierda, datos derecha) y
              separador entre filas: las pastillas en línea aparte quedaban
              flotando y el ojo las emparejaba con la transportadora EQUIVOCADA. */}
          {couriers.length > 0 && (
            <Section icon={Truck} label="Por transportadora" count={couriers.length}>
              <ul className="divide-y divide-border/40" data-testid="lista-transportadoras">
                {couriers.map((c, i) => {
                  const name = courierName(countryCode, c.courierId);
                  return (
                    <li key={c.courierId} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <CarrierAvatar name={name} />
                        <span className="min-w-0 truncate text-[11px] font-semibold text-foreground">{name}</span>
                        {i === 0 && couriers.length > 1 && (
                          <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">más usada</span>
                        )}
                      </div>
                      <div className="ml-auto">
                        <PillRow delivered={c.delivered} returned={c.returned} transit={c.transit} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {/* Por rango de precio — mismo ritmo de filas con separador. */}
          {all.byPrice.length > 0 && (
            <Section icon={DollarSign} label="Por precio" count={all.byPrice.length}>
              {/* El label con basis natural (sin flex-1/basis-0): así el wrap
                  SÍ se dispara y las pastillas bajan de línea en 375px en vez
                  de aplastar "$50.000 - $100.000" a "$50.00…". */}
              <ul className="divide-y divide-border/40">
                {all.byPrice.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
                    <span className="text-[11px] font-medium text-foreground whitespace-nowrap">{p.label}</span>
                    <div className="ml-auto">
                      <PillRow delivered={p.delivered} returned={p.returned} transit={p.transit} />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Contra entrega. */}
          {cod.length > 0 && (
            <Section icon={Wallet} label="Contra entrega">
              <ul className="divide-y divide-border/40">
                {cod.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
                    <span className="text-[11px] font-medium text-foreground whitespace-nowrap">Pago contra entrega</span>
                    <div className="ml-auto">
                      <PillRow delivered={p.delivered} returned={p.returned} transit={p.transit} />
                    </div>
                  </li>
                ))}
              </ul>
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
