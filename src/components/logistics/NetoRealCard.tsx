import { useEffect, useState } from 'react';
import { TrendingUp, AlertTriangle } from 'lucide-react';
import { formatCOP, getCurrencyCountry, paisUsaCentavos } from '@/lib/utils';
import { parseValorInput } from '@/lib/orderAlerts';
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
  /** Días del período con pauta anotada en la bitácora (cobertura). */
  diasConPauta?: number;
  /** Días transcurridos del período (para medir la cobertura de pauta). */
  diasPeriodo?: number;
}

// Montos en la moneda de la tienda: CO son enteros COP, pero EC (USD) y GT (GTQ)
// llevan centavos — el strip "solo dígitos" que había acá convertía "150.50" en
// 15050 (100×) y ese admin inflado se restaba del Neto Real. Mismo bug (y mismo
// fix, parseValorInput) que ya cobró en el diálogo de pauta y el simulador.
function parseInput(v: string): number {
  const n = parseValorInput(v);
  if (n == null || !isFinite(n) || n < 0) return 0;
  return paisUsaCentavos(getCurrencyCountry()) ? Math.round(n * 100) / 100 : Math.round(n);
}

export default function NetoRealCard({
  operativo, yearMonth, canEdit, pautaTotal, pautaFromDaily,
  pedidosEnCalle, movimientosSinLink = 0, diasConPauta, diasPeriodo,
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
      : 'cargá en Pauta diaria (abajo)';

  // Cobertura de pauta: días sin registro entran como $0 y el neto sale inflado.
  // Se dice en la cara — cero nunca sustituye a "no se anotó".
  const pautaIncompleta =
    pautaFromDaily && (diasPeriodo ?? 0) > 0 && (diasConPauta ?? 0) < (diasPeriodo ?? 0);

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d hairline-top space-y-3">
      <div className="flex items-center gap-2">
        <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0">
          <TrendingUp size={17} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block hud-label">Neto real del mes</span>
          <span className="block text-[10px] text-muted-foreground/70 mt-0.5">
            lo que ganó la operación, menos publicidad y gastos fijos
          </span>
        </span>
      </div>

      {/* La resta escrita con palabras, un renglón por concepto — la fórmula en
          mono chiquito no la entendía el dueño (23-ago-2026). */}
      <div className="rounded-xl border border-border bg-card/40 divide-y divide-border text-xs">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="text-muted-foreground">Ganancia de la operación (operativo)</span>
          <span className="font-mono tabular-nums text-foreground shrink-0">{formatCOP(operativo)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="text-muted-foreground">
            − Publicidad (pauta)
            <span className="block text-[10px] text-muted-foreground/70">{pautaHint}</span>
          </span>
          <span className="font-mono tabular-nums text-danger shrink-0">−{formatCOP(pautaTotal)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="text-muted-foreground">
            − Costos admin del mes
            <span className="block text-[10px] text-muted-foreground/70">arriendo, sueldos, internet… (editable abajo)</span>
          </span>
          <span className="font-mono tabular-nums text-danger shrink-0">−{formatCOP(costosAdmin)}</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-foreground/[0.02]">
          <span className="text-foreground font-semibold">Neto real</span>
          <span className={`text-2xl font-mono font-bold tabular-nums leading-none shrink-0 ${neto >= 0 ? 'text-success' : 'text-danger'}`}>
            {formatCOP(neto)}
          </span>
        </div>
      </div>

      {/* Pauta coja = neto inflado. Se avisa ANTES de que decida con ese número. */}
      {pautaIncompleta && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/8 px-3 py-2">
          <AlertTriangle size={12} className="text-warning shrink-0 mt-0.5" />
          <p className="text-[11px] text-warning leading-relaxed">
            Solo <strong>{diasConPauta} de {diasPeriodo} días</strong> tienen pauta anotada — los
            días sin registro entran como $0, así que este neto está{' '}
            <strong>inflado</strong> por la pauta que falta cargar.
          </p>
        </div>
      )}
      {pautaTotal === 0 && !pautaIncompleta && (
        <p className="text-[11px] text-warning leading-relaxed">
          Sin pauta anotada este mes: el neto no está descontando publicidad.
        </p>
      )}

      {canEdit && (
        <div className="flex items-end justify-between gap-3">
          <CostInput label="Costos admin (mensual)" value={costosAdmin} onChange={setCostosAdmin} />
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

      <p className="text-[10px] text-muted-foreground leading-relaxed">
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
  // Texto local: si el input mostrara `String(value)` directo, al tipear
  // "150." el parse devuelve 150, el padre re-renderiza y el punto desaparece
  // antes de poder escribir los centavos. Solo se resiembra cuando el valor
  // llega de AFUERA (la fila guardada), no como eco del propio tipeo.
  const [text, setText] = useState(value === 0 ? '' : String(value));
  useEffect(() => {
    if (parseInput(text) !== value) setText(value === 0 ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="block flex-1 rounded-xl border border-border bg-card/40 px-3 py-2.5 space-y-1.5">
      <span className="block hud-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={paisUsaCentavos(getCurrencyCountry()) ? '150.50' : '0'}
        onChange={(e) => { setText(e.target.value); onChange(parseInput(e.target.value)); }}
        className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm font-mono tabular-nums transition-colors duration-200 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none focus:outline-none"
      />
    </label>
  );
}
