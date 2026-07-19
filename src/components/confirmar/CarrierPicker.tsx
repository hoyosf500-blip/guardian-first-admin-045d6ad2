import { Loader2, Truck, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCOP } from '@/lib/utils';

export interface CarrierOption {
  id: number | string;
  name: string;
  typeService: string;
  shippingAmount: number;
}

interface Props {
  options: CarrierOption[] | null;
  loading: boolean;
  error: string | null;
  /** Nombre de la transportadora actual del pedido (para el chip "actual"). */
  currentName: string;
  /** null = mantener la actual (sin cambio). */
  selected: CarrierOption | null;
  onSelect: (opt: CarrierOption) => void;
  onRetry: () => void;
}

// Radio-list de transportadoras estilo panel Dropi — mismo markup verificado
// del viejo ChangeCarrierDialog (check cyan, chip "actual", flete formatCOP).
export default function CarrierPicker({ options, loading, error, currentName, selected, onSelect, onRetry }: Props) {
  const currentNorm = (currentName || '').trim().toUpperCase();

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Cotizando con Dropi…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-attention/30 bg-attention/10 p-3 text-sm text-attention dark:text-attention space-y-2 shadow-card3d">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
          <RefreshCw size={13} aria-hidden="true" /> Reintentar
        </Button>
      </div>
    );
  }

  if (!options || options.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Dropi no devolvió transportadoras para este pedido.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {options.map((opt) => {
        const isCurrent = opt.name.trim().toUpperCase() === currentNorm;
        // Sin selección explícita, la ACTUAL se pinta seleccionada (se mantiene).
        const isSelected = selected
          ? selected.id === opt.id && selected.name === opt.name
          : isCurrent;
        return (
          <button
            key={`${opt.id}-${opt.name}`}
            type="button"
            onClick={() => onSelect(opt)}
            className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-left transition-[color,background-color,border-color,box-shadow] ${
              isSelected
                ? 'border-cyan bg-cyan/10 shadow-[0_0_18px_-6px_hsl(var(--cyan)/0.4)] dark:shadow-[0_0_18px_-6px_hsl(var(--cyan)/0.9)]'
                : 'border-border bg-card hover:bg-muted/50'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {isSelected ? (
                <CheckCircle2 size={16} className="text-cyan flex-shrink-0" aria-hidden="true" />
              ) : (
                <Truck size={16} className="text-muted-foreground flex-shrink-0" aria-hidden="true" />
              )}
              <span className="font-semibold text-sm truncate">{opt.name}</span>
              {isCurrent && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium flex-shrink-0">
                  actual
                </span>
              )}
            </div>
            <span className={`font-mono text-sm font-semibold flex-shrink-0 ${isSelected ? 'text-cyan' : ''}`}>
              {formatCOP(opt.shippingAmount)}
            </span>
          </button>
        );
      })}
      <p className="text-[11px] text-muted-foreground pt-1">
        El precio es el flete que cotiza Dropi para esta ruta.
      </p>
    </div>
  );
}
