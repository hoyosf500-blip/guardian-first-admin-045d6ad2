import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { OrderData } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { toast } from 'sonner';
import { Loader2, Truck, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';

interface CarrierOption {
  id: number | string;
  name: string;
  typeService: string;
  shippingAmount: number;
}

interface QuoteResponse {
  ok?: boolean;
  error?: string;
  current?: string;
  options?: CarrierOption[];
  dropiBody?: unknown;
}

interface ApplyResponse {
  ok?: boolean;
  error?: string;
  dropiHttpStatus?: number;
  dropiBody?: unknown;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderData;
  onSuccess?: () => void;
}

// Cotiza en vivo (panel web de Dropi) las transportadoras que pueden despachar
// el pedido + su precio, deja elegir otra y la reasigna de verdad en Dropi vía
// la edge function dropi-change-carrier. Solo para pedidos sin guía generada.
export default function ChangeCarrierDialog({ open, onOpenChange, order, onSuccess }: Props) {
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [options, setOptions] = useState<CarrierOption[] | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<CarrierOption | null>(null);

  const currentNorm = (order.transportadora || '').trim().toUpperCase();

  const fetchQuote = useCallback(async () => {
    if (!order.externalId) {
      setErrorMsg('Este pedido no tiene ID externo de Dropi.');
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    setOptions(null);
    setSelected(null);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-change-carrier', {
        body: { externalId: order.externalId, mode: 'quote' },
      });
      const d = (data as QuoteResponse | null) ?? null;
      if (error && !d) {
        setErrorMsg(error instanceof Error ? error.message : 'No se pudo cotizar con Dropi.');
        return;
      }
      if (!d?.ok) {
        setErrorMsg(d?.error || 'No se pudo cotizar con Dropi.');
        return;
      }
      setOptions(d.options || []);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Error inesperado al cotizar.');
    } finally {
      setLoading(false);
    }
  }, [order.externalId]);

  useEffect(() => {
    if (open) fetchQuote();
  }, [open, fetchQuote]);

  const handleApply = async () => {
    if (!selected || !order.externalId) return;
    setApplying(true);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-change-carrier', {
        body: {
          externalId: order.externalId,
          mode: 'apply',
          distributionCompanyId: selected.id,
          name: selected.name,
        },
      });
      const d = (data as ApplyResponse | null) ?? null;
      if (error || !d?.ok) {
        const shortMsg = d?.error || (error instanceof Error ? error.message : 'Error desconocido');
        const dropiHttpStatus = d?.dropiHttpStatus;
        const dropiBody = d?.dropiBody;
        toast.error('Dropi no aceptó el cambio de transportadora', {
          description: (
            <div className="space-y-2">
              <p className="text-xs">{shortMsg}</p>
              {(dropiHttpStatus !== undefined || dropiBody !== undefined) && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold">Detalle técnico</summary>
                  <pre className="font-mono text-[11px] mt-1 p-2 bg-muted/40 rounded border border-border whitespace-pre-wrap break-all max-h-48 overflow-auto">
{`HTTP ${dropiHttpStatus ?? 'n/a'}\n\n${JSON.stringify(dropiBody ?? {}, null, 2)}`}
                  </pre>
                </details>
              )}
            </div>
          ),
          duration: 15000,
        });
        return;
      }
      toast.success(`Transportadora cambiada a ${selected.name}`);
      onSuccess?.();
      onOpenChange(false);
    } catch (e) {
      toast.error('No se pudo cambiar la transportadora: ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/20 flex items-center justify-center flex-shrink-0">
              <Truck size={18} className="text-cyan-500" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle className="text-lg">Cambiar transportadora</DialogTitle>
              <DialogDescription className="text-xs">
                Actual: <strong>{order.transportadora || 'sin asignar'}</strong> · cotización en vivo de Dropi
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-2 py-2 min-h-[120px]">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" /> Cotizando con Dropi…
            </div>
          )}

          {!loading && errorMsg && (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3 text-sm text-orange-700 dark:text-orange-400 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
              <Button variant="outline" size="sm" onClick={fetchQuote} className="gap-1.5">
                <RefreshCw size={13} /> Reintentar
              </Button>
            </div>
          )}

          {!loading && !errorMsg && options && options.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Dropi no devolvió transportadoras para este pedido.
            </div>
          )}

          {!loading && !errorMsg && options && options.length > 0 && (
            <div className="space-y-1.5">
              {options.map((opt) => {
                const isCurrent = opt.name.trim().toUpperCase() === currentNorm;
                const isSelected = selected?.id === opt.id && selected?.name === opt.name;
                return (
                  <button
                    key={`${opt.id}-${opt.name}`}
                    type="button"
                    onClick={() => setSelected(opt)}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      isSelected
                        ? 'border-cyan-500 bg-cyan-500/10'
                        : 'border-border bg-card hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isSelected ? (
                        <CheckCircle2 size={16} className="text-cyan-500 flex-shrink-0" />
                      ) : (
                        <Truck size={16} className="text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="font-semibold text-sm truncate">{opt.name}</span>
                      {isCurrent && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium flex-shrink-0">
                          actual
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-sm font-semibold flex-shrink-0">
                      {formatCOP(opt.shippingAmount)}
                    </span>
                  </button>
                );
              })}
              <p className="text-[11px] text-muted-foreground pt-1">
                El precio es el flete que cotiza Dropi para esta ruta.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applying}>
            Cancelar
          </Button>
          <Button
            onClick={handleApply}
            disabled={!selected || applying || (selected?.name.trim().toUpperCase() === currentNorm)}
            className="bg-cyan-500 hover:bg-cyan-600 text-white font-semibold"
          >
            {applying && <Loader2 size={14} className="mr-2 animate-spin" aria-hidden="true" />}
            Aplicar cambio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
