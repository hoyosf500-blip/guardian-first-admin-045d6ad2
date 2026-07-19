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

/** Rótulo de campo. Debe coincidir con `LABEL_CLS` de CustomerForm: las dos
 *  columnas del editor se miran una al lado de la otra y hasta ahora esta iba
 *  en 10px sin mayúsculas mientras la otra iba en 12px con mayúsculas. */
const LABEL_CLS = 'text-xs uppercase tracking-wider text-muted-foreground';

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
        <Package size={14} className="text-accent" aria-hidden="true" />
        <h3 className="hud-label text-foreground">
          Producto y valor
        </h3>
      </header>

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 py-6 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Cargando productos del pedido…
        </div>
      )}

      {!loading && unavailableNote && (
        /* Misma gramática de aviso guiado que el resto del editor: rail + chip
           de ícono. Explica por qué no se puede editar acá, no es un error. */
        <div className="relative overflow-hidden rounded-xl border border-border bg-muted/30 p-3 pl-4 text-xs text-muted-foreground flex items-start gap-2.5">
          <span className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full bg-muted-foreground/40" aria-hidden="true" />
          <span className="w-6 h-6 rounded-lg bg-muted border border-border flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <Info size={12} />
          </span>
          <span className="pt-0.5 leading-relaxed">{unavailableNote}</span>
        </div>
      )}

      {!loading && drafts && drafts.map((d) => {
        const line = draftToLine(d);
        const priceInvalid = d.priceRaw.trim() !== '' && parseValorInput(d.priceRaw) == null;
        return (
          <div key={d.dropiId} className="rounded-xl border border-border bg-card p-3 space-y-2.5 shadow-card3d hairline-top">
            <div className="flex items-center justify-between gap-2">
              {/* Sin .hud-label: el nombre del producto viene de Dropi y esa
                  clase lo mayusculizaría, o sea reescribiría el dato. */}
              <span className="text-sm font-semibold truncate">
                {d.name || productoFallback || `Producto ${d.dropiId}`}
              </span>
              <span className="text-[10px] font-mono tabular-nums text-muted-foreground bg-muted border border-border rounded-md px-1.5 py-0.5 flex-shrink-0">ID {d.dropiId}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`price-${d.dropiId}`} className={LABEL_CLS}>Precio de venta</Label>
                <Input
                  id={`price-${d.dropiId}`}
                  inputMode="decimal"
                  value={d.priceRaw}
                  onChange={e => onPatch(d.dropiId, { priceRaw: e.target.value })}
                  className={`font-mono tabular-nums ${priceInvalid ? 'border-destructive' : ''}`}
                />
                {priceInvalid && <p className="text-[10px] text-destructive">Número inválido</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor={`qty-${d.dropiId}`} className={LABEL_CLS}>Cantidad</Label>
                <Input
                  id={`qty-${d.dropiId}`}
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={String(d.quantity)}
                  className="font-mono tabular-nums"
                  onChange={e => {
                    const n = Math.floor(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 1 && n <= 1000) onPatch(d.dropiId, { quantity: n });
                  }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border pt-2">
              <span className="uppercase tracking-wider">Subtotal</span>
              <span className="font-mono tabular-nums font-semibold text-foreground">{formatCOP(line.price * line.quantity)}</span>
            </div>
          </div>
        );
      })}

      {!loading && drafts && linesChanged && (
        <Button variant="outline" size="sm" onClick={onRequote} disabled={requoting} className="gap-1.5 w-full rounded-xl">
          {requoting ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          Recotizar flete con las cantidades nuevas
        </Button>
      )}

      {/* Total a recaudar: derivado de las líneas, con override manual opcional.
          Es la cifra que la asesora le confirma al cliente en voz alta y la que
          va a cobrar el mensajero, así que es la única "hero" del diálogo:
          rótulo HUD, número más grande y tabular, y separación del control de
          ajuste (que es secundario) con una línea. */}
      <div className="rounded-2xl border border-accent/30 bg-accent/[0.08] px-3.5 py-3 space-y-2.5 shadow-card3d hairline-top">
        <div className="flex items-center justify-between gap-3">
          <span className="hud-label text-muted-foreground dark:text-accent">Total a recaudar</span>
          <span className={`font-mono tabular-nums text-2xl font-bold leading-none ${totalChanged ? 'text-warning' : 'num-glow-accent'}`}>
            {formatCOP(finalTotal)}
          </span>
        </div>
        {totalChanged && (
          /* Sin tachado y sin aria-hidden en la flecha: a 11px el tachado
             estorba más de lo que aclara, y ocultar el "→" dejaba el renglón
             leyéndose "Actual: X nuevo: Y", que pierde la relación. La
             jerarquía la da el peso: el valor nuevo va en ámbar y en negrita. */
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <span className="font-mono tabular-nums">Actual: {formatCOP(currentValor)}</span>
            <span>→</span>
            <span>nuevo: <strong className="font-mono tabular-nums text-warning">{formatCOP(finalTotal)}</strong></span>
          </p>
        )}
        <div className="space-y-1 pt-2 border-t border-accent/20">
          <Label htmlFor="total-override" className="text-[11px] text-muted-foreground leading-snug block">
            Ajustar total a mano (opcional — manda sobre la suma de líneas)
          </Label>
          <Input
            id="total-override"
            inputMode="decimal"
            value={overrideRaw}
            onChange={e => onOverrideRaw(e.target.value)}
            placeholder="Ej: 59.900 o 26,99"
            className={`font-mono tabular-nums bg-card ${overrideInvalid ? 'border-destructive' : ''}`}
          />
          {overrideInvalid && <p className="text-[10px] text-destructive">Escribí un número válido mayor a 0.</p>}
        </div>
      </div>
    </section>
  );
}
