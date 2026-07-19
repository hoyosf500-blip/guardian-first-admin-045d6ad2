import { useEffect, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  useLogisticaMonthlyCosts,
  useUpsertLogisticaMonthlyCosts,
} from '@/hooks/useLogisticaMonthlyCosts';

// Bloque "Neto Real" de "Cómo voy": resta pauta + costos admin al OPERATIVO del
// mes (hoy = ganancia neta del wallet — ver MesActualResumen, // OPERATIVO_BASE).
//
// PAUTA (desde 2026-07): la pauta ya NO se edita acá — viene de la bitácora
// "Pauta diaria" (store_ad_spend_daily), sumada por MesActualResumen y pasada por
// `pautaTotal`. Así se carga día por día y se resta UNA sola vez (sin doble
// descuento ni doble carga). Para meses viejos sin registros diarios, el padre
// pasa el valor mensual guardado como fallback (`pautaFromDaily=false`).
//
// COSTOS ADMIN sí se siguen editando acá (input mensual, persistido en
// logistica_monthly_costs vía RPC store-scoped). Si la tabla no está aplicada, el
// hook devuelve ceros y el bloque NO rompe.

interface Props {
  /** Operativo del mes (base del neto). Hoy = operativo por cohorte de pedido. */
  operativo: number;
  /** 'YYYY-MM' del mes mostrado. */
  yearMonth: string;
  /** Solo el dueño de la tienda edita/guarda los costos. */
  canEdit: boolean;
  /** Pauta del período (ya resuelta por el padre: diaria si hay, si no mensual). */
  pautaTotal: number;
  /** true = la pauta viene de la bitácora diaria; false = fallback mensual guardado. */
  pautaFromDaily: boolean;
  /** Pedidos sin cerrar — el neto sube cuando se entregan. */
  pedidosEnCalle?: number;
  /** Movimientos de wallet con related_order_id que no cruzó a un pedido (transparencia). */
  movimientosSinLink?: number;
}

// COP son enteros — descartamos todo lo que no sea dígito o signo (acepta
// "1.000.000" tipeado con separadores de miles).
function parseInput(v: string): number {
  const n = Number(v.replace(/[^\d-]/g, ''));
  return isFinite(n) ? n : 0;
}

export default function NetoRealCard({
  operativo, yearMonth, canEdit, pautaTotal, pautaFromDaily,
  pedidosEnCalle, movimientosSinLink = 0,
}: Props) {
  const { data: saved } = useLogisticaMonthlyCosts(yearMonth);
  const upsert = useUpsertLogisticaMonthlyCosts();

  // Solo "Costos admin" es editable acá; la pauta viene de la bitácora diaria.
  const [costosAdmin, setCostosAdmin] = useState(0);

  // Re-sembrar cuando llega la fila guardada o cambia el mes.
  useEffect(() => {
    setCostosAdmin(saved?.costos_admin ?? 0);
  }, [saved?.costos_admin, yearMonth]);

  const totalCostos = pautaTotal + costosAdmin;
  const neto = operativo - totalCostos;

  const dirty = costosAdmin !== (saved?.costos_admin ?? 0);

  const pautaHint = pautaFromDaily
    ? 'de tu Pauta diaria'
    : pautaTotal > 0
      ? 'valor mensual guardado'
      : 'cargá en Pauta diaria';

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-3.5 shadow-card3d hairline-top space-y-3">
      <div className="flex items-center gap-2">
        <TrendingUp size={13} className="text-accent" />
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
          Neto real del mes
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {/* Pauta — read-only, viene de la bitácora diaria (o fallback mensual) */}
        <div className="space-y-1">
          <span className="block text-[10px] text-muted-foreground">Pauta{pautaFromDaily ? ' (diaria)' : ''}</span>
          <span className="block text-xs tabular-nums text-foreground">{formatCOP(pautaTotal)}</span>
          <span className="block text-[9px] text-muted-foreground/70">{pautaHint}</span>
        </div>
        {/* Costos admin — editable mensual */}
        {canEdit ? (
          <CostInput label="Costos admin" value={costosAdmin} onChange={setCostosAdmin} />
        ) : (
          <ReadOnly label="Costos admin" value={costosAdmin} />
        )}
      </div>

      {canEdit && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={!dirty || upsert.isPending}
            onClick={() =>
              // Guarda SOLO costos_admin; preserva la pauta mensual guardada
              // (fallback histórico) sin pisarla — la pauta se maneja en la bitácora.
              upsert.mutate({
                yearMonth,
                pauta_meta: saved?.pauta_meta ?? 0,
                pauta_tiktok: saved?.pauta_tiktok ?? 0,
                costos_admin: costosAdmin,
              })
            }
          >
            {upsert.isPending ? 'Guardando…' : dirty ? 'Guardar' : 'Guardado'}
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <span className="text-xs text-foreground font-medium">
          Neto real
          <span className="block text-[10px] text-muted-foreground/70">
            Operativo {formatCOP(operativo)} − pauta {formatCOP(pautaTotal)} − admin {formatCOP(costosAdmin)}
          </span>
        </span>
        <span className={`text-lg font-bold tabular-nums shrink-0 ${neto >= 0 ? 'text-green' : 'text-red'}`}>
          {formatCOP(neto)}
        </span>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Realizado a hoy. Sube cuando se entreguen los{' '}
        {pedidosEnCalle != null ? `${pedidosEnCalle.toLocaleString('es-CO')} ` : ''}pedidos en la calle.
        No incluye deudas personales.
        {movimientosSinLink > 0 && (
          <span className="block text-muted-foreground/70">
            {movimientosSinLink} movimiento{movimientosSinLink === 1 ? '' : 's'} del wallet sin pedido vinculado (no contados en el operativo).
          </span>
        )}
      </p>
    </div>
  );
}

function CostInput({
  label, value, onChange,
}: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value === 0 ? '' : String(value)}
        placeholder="0"
        onChange={(e) => onChange(parseInput(e.target.value))}
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

function ReadOnly({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <span className="block text-xs tabular-nums text-foreground">{formatCOP(value)}</span>
    </div>
  );
}
