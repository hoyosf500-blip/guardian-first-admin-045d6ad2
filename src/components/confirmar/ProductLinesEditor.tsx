import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { formatCOP } from '@/lib/utils';
import { parseValorInput } from '@/lib/orderAlerts';
import type { EditableLine } from '@/lib/orderEditPlan';
import { Package, Loader2, RefreshCw, Info } from 'lucide-react';

// Editor de líneas de producto del editor unificado — estilo card del panel
// Dropi: nombre, precio de venta editable, cantidad editable, subtotal.
// PRESENTACIONAL: el diálogo padre es dueño de los drafts (para dirty flags y
// submit); acá solo se pintan inputs y se reportan cambios vía onPatch.

/** Borrador editable de una línea. `priceRaw` es el texto tal como lo tipea la
 *  operadora ("26,99" / "59.900"); base* = lo que devolvió el quote (Dropi). */
export interface LineDraft {
  dropiId: number;
  name?: string;
  quantity: number;
  priceRaw: string;
  basePrice: number;
  baseQuantity: number;
}

/** Draft → línea efectiva para cálculos/envío. Precio inválido → el base
 *  (nunca se manda basura; el input muestra el hint rojo mientras tanto). */
export function draftToLine(d: LineDraft): EditableLine {
  const parsed = parseValorInput(d.priceRaw);
  return {
    dropiId: d.dropiId,
    name: d.name,
    quantity: d.quantity,
    price: parsed != null && parsed >= 0 ? parsed : d.basePrice,
  };
}

interface Props {
  drafts: LineDraft[] | null;
  loading: boolean;
  /** Motivo por el que NO se pueden editar líneas (quote falló / función vieja). */
  unavailableNote: string | null;
  onPatch: (dropiId: number, patch: Partial<Pick<LineDraft, 'quantity' | 'priceRaw'>>) => void;
  /** Override manual del total a recaudar ('' = derivado de las líneas). */
  overrideRaw: string;
  onOverrideRaw: (s: string) => void;
  finalTotal: number;
  currentValor: number;
  linesChanged: boolean;
  onRequote: () => void;
  requoting: boolean;
  /** Nombre del producto de la fila local — fallback si Dropi no mandó name. */
  productoFallback?: string;
}

export default function ProductLinesEditor({
  drafts, loading, unavailableNote, onPatch,
  overrideRaw, onOverrideRaw, finalTotal, currentValor,
  linesChanged, onRequote, requoting, productoFallback,
}: Props) {
  const overrideParsed = overrideRaw.trim() ? parseValorInput(overrideRaw) : null;
  const overrideInvalid = overrideRaw.trim() !== '' && (overrideParsed == null || overrideParsed <= 0);
  const totalChanged = Math.abs(finalTotal - (currentValor || 0)) > 0.009;

  return (
    <section className="space-y-3">
      <header className="flex items-center gap-2 pb-2 border-b border-border">
        <Package size={14} className="text-muted-foreground" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Producto y valor
        </h3>
      </header>

      {loading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Cargando productos del pedido…
        </div>
      )}

      {!loading && unavailableNote && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
          <Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{unavailableNote}</span>
        </div>
      )}

      {!loading && drafts && drafts.map((d) => {
        const line = draftToLine(d);
        const priceInvalid = d.priceRaw.trim() !== '' && parseValorInput(d.priceRaw) == null;
        return (
          <div key={d.dropiId} className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold truncate">
                {d.name || productoFallback || `Producto ${d.dropiId}`}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">ID {d.dropiId}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`price-${d.dropiId}`} className="text-[10px] text-muted-foreground">Precio de venta</Label>
                <Input
                  id={`price-${d.dropiId}`}
                  inputMode="decimal"
                  value={d.priceRaw}
                  onChange={e => onPatch(d.dropiId, { priceRaw: e.target.value })}
                  className={priceInvalid ? 'border-destructive' : undefined}
                />
                {priceInvalid && <p className="text-[10px] text-destructive">Número inválido</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor={`qty-${d.dropiId}`} className="text-[10px] text-muted-foreground">Cantidad</Label>
                <Input
                  id={`qty-${d.dropiId}`}
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={String(d.quantity)}
                  onChange={e => {
                    const n = Math.floor(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 1 && n <= 1000) onPatch(d.dropiId, { quantity: n });
                  }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Subtotal</span>
              <span className="font-mono font-semibold text-foreground">{formatCOP(line.price * line.quantity)}</span>
            </div>
          </div>
        );
      })}

      {!loading && drafts && linesChanged && (
        <Button variant="outline" size="sm" onClick={onRequote} disabled={requoting} className="gap-1.5 w-full">
          {requoting ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          Recotizar flete con las cantidades nuevas
        </Button>
      )}

      {/* Total a recaudar: derivado de las líneas, con override manual opcional */}
      <div className="rounded-lg border border-border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total a recaudar</span>
          <span className={`font-mono text-base font-bold ${totalChanged ? 'text-amber-500' : ''}`}>
            {formatCOP(finalTotal)}
          </span>
        </div>
        {totalChanged && (
          <p className="text-[11px] text-muted-foreground">
            Actual: {formatCOP(currentValor)} → nuevo: <strong>{formatCOP(finalTotal)}</strong>
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor="total-override" className="text-[10px] text-muted-foreground">
            Ajustar total a mano (opcional — manda sobre la suma de líneas)
          </Label>
          <Input
            id="total-override"
            inputMode="decimal"
            value={overrideRaw}
            onChange={e => onOverrideRaw(e.target.value)}
            placeholder="Ej: 59.900 o 26,99"
            className={overrideInvalid ? 'border-destructive' : undefined}
          />
          {overrideInvalid && <p className="text-[10px] text-destructive">Escribí un número válido mayor a 0.</p>}
        </div>
      </div>
    </section>
  );
}
