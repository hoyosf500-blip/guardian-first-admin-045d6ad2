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

  // Caja punteada de alto fijo en los tres estados sin lista: reserva el hueco
  // que van a ocupar las tarjetas, así la columna no pega un salto cuando llega
  // la cotización y la asesora no pierde de vista dónde estaba mirando.
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 py-8 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Cotizando con Dropi…
      </div>
    );
  }

  if (error) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-attention/30 bg-attention/10 p-3 pl-4 text-sm text-attention dark:text-attention space-y-2.5 shadow-card3d hairline-top">
        <span className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full bg-attention" aria-hidden="true" />
        <div className="flex items-start gap-2.5">
          <span className="w-6 h-6 rounded-lg bg-attention/14 border border-attention/30 flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <AlertTriangle size={13} />
          </span>
          <span className="pt-0.5 leading-relaxed">{error}</span>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 rounded-lg">
          <RefreshCw size={13} aria-hidden="true" /> Reintentar
        </Button>
      </div>
    );
  }

  if (!options || options.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 py-6 px-3 text-center text-sm text-muted-foreground">
        Dropi no devolvió transportadoras para este pedido.
      </div>
    );
  }

  // Referencia para la barra proporcional de flete. NO es una métrica nueva:
  // es el mismo `shippingAmount` que ya se imprime al lado, dibujado a escala
  // para que "cuál sale más caro" se vea sin comparar cifras a ojo. Si hay una
  // sola opción no se dibuja (una barra al 100% no compara nada), y con máximo
  // 0 tampoco (no habría escala real que mostrar).
  const maxFlete = Math.max(...options.map(o => Number(o.shippingAmount) || 0));
  const showBars = options.length > 1 && maxFlete > 0;

  return (
    <div className="space-y-2">
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
            className={`w-full flex flex-col gap-2.5 px-3 py-2.5 rounded-xl border text-left hairline-top transition-[color,background-color,border-color,box-shadow] ${
              isSelected
                ? 'border-cyan bg-cyan/10 shadow-[0_0_18px_-6px_hsl(var(--cyan)/0.4)] dark:shadow-[0_0_18px_-6px_hsl(var(--cyan)/0.9)]'
                : 'border-border bg-card hover:bg-muted/50 hover:border-border-strong'
            }`}
          >
            <div className="w-full flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-8 h-8 rounded-xl border flex items-center justify-center flex-shrink-0 transition-colors ${
                  isSelected ? 'bg-cyan/16 border-cyan/40 text-cyan' : 'bg-muted/60 border-border text-muted-foreground'
                }`} aria-hidden="true">
                  {isSelected ? <CheckCircle2 size={15} /> : <Truck size={15} />}
                </span>
                {/* Sin .hud-label: el nombre viene verbatim de Dropi y esa clase
                    lo mayusculizaría, o sea reescribiría el dato. */}
                <span className="font-semibold text-sm truncate">{opt.name}</span>
                {isCurrent && (
                  /* .hud-label-cased y NO .hud-label: es un rótulo nuestro, pero
                     la versión que mayusculiza convertiría "actual" en "ACTUAL"
                     y acá el chip tiene que susurrar, no gritar. */
                  <span className="hud-label-cased px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border flex-shrink-0">
                    actual
                  </span>
                )}
              </div>
              <span className={`font-mono tabular-nums text-sm font-semibold flex-shrink-0 ${isSelected ? 'text-cyan' : ''}`}>
                {formatCOP(opt.shippingAmount)}
              </span>
            </div>
            {showBars && (
              /* La barra plana no se leía como dato, se leía como separador.
                 Ahora es un degradado (pleno → apagado) con el mismo halo que
                 usan las barras de Logística. Sin `overflow-hidden` en el
                 riel: recortaba el glow del relleno contra el borde. */
              <div className="w-full h-1.5 rounded-full bg-foreground/[0.07]" aria-hidden="true">
                <div
                  className={`h-full rounded-full transition-[width] duration-700 bg-gradient-to-r ${
                    isSelected
                      ? 'from-cyan to-cyan/40 shadow-[0_0_10px_-2px_hsl(var(--cyan)/0.5)] dark:shadow-[0_0_10px_-2px_hsl(var(--cyan)/0.95)]'
                      : 'from-muted-foreground/55 to-muted-foreground/20'
                  }`}
                  style={{ width: `${((Number(opt.shippingAmount) || 0) / maxFlete) * 100}%` }}
                />
              </div>
            )}
          </button>
        );
      })}
      <p className="text-[11px] text-muted-foreground pt-1">
        El precio es el flete que cotiza Dropi para esta ruta.
      </p>
    </div>
  );
}
