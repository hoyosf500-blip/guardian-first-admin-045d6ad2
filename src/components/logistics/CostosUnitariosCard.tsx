import { useMemo } from 'react';
import {
  Truck, PackageX, Receipt, Target, TrendingUp, AlertTriangle, Info,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { useCostosUnitarios } from '@/hooks/useCostosUnitarios';
import { calcularCostosUnitarios } from '@/lib/costosUnitarios';

// "Cuánto me cuesta cada entrega" — los costos unitarios reales de la operación.
//
// Existe porque Guardian calculaba el flete promedio pero no lo mostraba en
// ninguna parte, y porque el número que sí importa —lo que cuesta una entrega
// contando el flete de las que se devolvieron— no existía.
//
// La tarjeta muestra las dos cifras JUNTAS a propósito. Ver solo el flete
// nominal es el error de cálculo más común en COD: si entregás 7 de cada 10,
// pagaste 10 fletes y cobraste 7.

interface Props {
  fromDate: string;
  toDate: string;
  ciudad?: string | null;
}

export default function CostosUnitariosCard({ fromDate, toDate, ciudad }: Props) {
  const q = useCostosUnitarios(fromDate, toDate, ciudad);
  const c = useMemo(() => calcularCostosUnitarios(q.data), [q.data]);

  if (q.isLoading) {
    return <div className="h-48 rounded-2xl bg-muted/30 animate-pulse" />;
  }

  // Migración pendiente: se dice, no se dibujan ceros (que se leerían como
  // "no te cuesta nada").
  if (q.data === null && !q.isLoading) {
    return (
      <div className="rounded-2xl border border-warning/30 bg-warning/8 p-5 text-sm">
        <p className="font-semibold text-warning flex items-center gap-2">
          <AlertTriangle size={15} /> Falta aplicar la migración de costos unitarios
        </p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Aplicá <code className="font-mono text-[11px]">20260806180000_costos_unitarios.sql</code>{' '}
          y esta tarjeta se enciende sola.
        </p>
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger/10 p-5 text-sm">
        <p className="font-semibold text-danger">No se pudieron leer los costos del período.</p>
        <p className="mt-1 text-[11px] font-mono text-muted-foreground">
          {(q.error as Error)?.message} · recargá.
        </p>
      </div>
    );
  }

  if (!c || c.entregados === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 p-6 text-center text-sm text-muted-foreground shadow-card3d">
        Todavía no hay entregas en este período — sin ellas no hay costo por entrega que calcular.
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden">
      <header className="px-5 py-3 border-b border-border">
        <h4 className="hud-label">Cuánto cuesta cada entrega</h4>
      </header>

      {/* Las dos cifras de flete, lado a lado. La de la derecha es la que sirve
          para poner precio; la de la izquierda es la que factura el carrier. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border">
        <Celda
          icon={Truck}
          label="Flete que te facturan"
          valor={c.fletePorEntrega}
          nota="por envío despachado"
          tono="neutral"
        />
        <Celda
          icon={Truck}
          label="Lo que te cuesta de verdad"
          valor={c.fleteRealPorEntrega}
          nota={
            c.multiplicador != null
              ? `${c.multiplicador.toFixed(2)}× · incluye el flete de los devueltos`
              : 'incluye el flete de los devueltos'
          }
          tono="alerta"
        />
      </div>

      {/* La explicación que convierte el número en una decisión. */}
      {c.multiplicador != null && c.multiplicador > 1.05 && c.tasaEntrega != null && (
        <div className="mx-5 mb-4 rounded-xl border border-info/30 bg-info/8 p-3.5 flex items-start gap-2">
          <TrendingUp size={14} className="text-info shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Con <strong className="text-foreground">{c.tasaEntrega.toFixed(1)}% de entrega</strong>,
            cada envío que llega carga con el flete de los que no llegaron: el costo se multiplica
            por <strong className="text-foreground">{c.multiplicador.toFixed(2)}</strong>. En este
            período se fueron <strong className="text-foreground">{formatCOP(c.fletePerdido)}</strong>{' '}
            en fletes de pedidos que se devolvieron.
            {' '}Subir la tasa de entrega baja este costo más que negociar la tarifa.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-border border-t border-border">
        <Celda icon={Receipt} label="Venta promedio" valor={c.ticketPromedio} nota="por entrega" tono="neutral" chico />
        <Celda icon={PackageX} label="Costo del producto" valor={c.cogsPorEntrega} nota="por entrega" tono="neutral" chico />
        <Celda icon={Target} label="Pauta por venta" valor={c.costoPorVenta} nota="conseguir una entrega" tono="neutral" chico />
        <Celda
          icon={TrendingUp}
          label="Margen por entrega"
          valor={c.margenPorEntrega}
          nota={c.margenPct != null ? `${c.margenPct.toFixed(1)}% del ticket · antes de pauta` : 'antes de pauta'}
          tono={c.margenPorEntrega != null && c.margenPorEntrega < 0 ? 'malo' : 'bueno'}
          chico
        />
      </div>

      {/* Costo por devolución — con su confiabilidad al lado, siempre. */}
      <div className="px-5 py-4 border-t border-border">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <span className="hud-label">Cuánto cuesta una devolución</span>
          {c.cargoDevolucionConfiable && c.costoTotalPorDevolucion != null ? (
            <span className="font-mono tabular-nums text-lg font-bold text-danger">
              {formatCOP(c.costoTotalPorDevolucion)}
            </span>
          ) : (
            <span className="font-mono tabular-nums text-lg font-bold text-muted-foreground">—</span>
          )}
        </div>

        {!c.cargoDevolucionConfiable && (
          <div className="mt-2 rounded-xl border border-warning/30 bg-warning/8 p-3 flex items-start gap-2">
            <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" />
            <p className="text-[11px] text-warning leading-relaxed">
              No se puede calcular todavía: la billetera tiene el cargo de solo{' '}
              <strong>{Math.round(c.coberturaCargo * c.devueltos)} de {c.devueltos} devoluciones</strong>{' '}
              del período ({Math.round(c.coberturaCargo * 100)}%).
              {c.cargoPorDevolucion != null && (
                <> Sobre esa muestra el cargo promedia {formatCOP(c.cargoPorDevolucion)}, pero con
                tan pocos casos ese número se mueve mucho de un mes a otro.</>
              )}{' '}
              Hay que sincronizar la billetera para cerrarlo.
            </p>
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-border flex items-start gap-2 text-[11px] text-muted-foreground">
        <Info size={13} className="text-info shrink-0 mt-0.5" />
        <p>
          El <strong className="text-foreground">margen por entrega</strong> ya descuenta el flete real
          {c.cargoDevolucionConfiable ? ' y el cargo de las devoluciones' : ''}, pero no la pauta
          {c.cargoDevolucionConfiable ? '' : ' ni el cargo de devolución (falta el dato)'}. Restale la{' '}
          <strong className="text-foreground">pauta por venta</strong> para ver lo que queda limpio.
        </p>
      </div>
    </section>
  );
}

function Celda({
  icon: Icon, label, valor, nota, tono, chico,
}: {
  icon: LucideIcon;
  label: string;
  valor: number | null;
  nota: string;
  tono: 'neutral' | 'alerta' | 'bueno' | 'malo';
  chico?: boolean;
}) {
  const color =
    tono === 'alerta' ? 'text-warning'
    : tono === 'malo' ? 'text-danger'
    : tono === 'bueno' ? 'text-success'
    : 'text-foreground';
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={13} className="text-muted-foreground" aria-hidden="true" />
        <span className="hud-label">{label}</span>
      </div>
      <div className={`font-mono tabular-nums font-bold ${chico ? 'text-lg' : 'text-[28px]'} ${color}`}>
        {valor == null ? '—' : formatCOP(valor)}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{nota}</div>
    </div>
  );
}
