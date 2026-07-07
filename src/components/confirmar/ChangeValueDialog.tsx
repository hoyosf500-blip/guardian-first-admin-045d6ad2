import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { OrderData } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { parseValorInput } from '@/lib/orderAlerts';
import { toast } from 'sonner';
import { Loader2, DollarSign, ArrowRight } from 'lucide-react';

interface ApplyValueResponse {
  ok?: boolean;
  error?: string;
  valorApplied?: boolean;
  method?: 'put' | 'recreate' | 'no_change';
  externalId?: string;
  oldExternalId?: string;
  valor?: number;
  transportadora?: string;
  warning?: string;
  dropiHttpStatus?: number;
  dropiBody?: unknown;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderData;
  /** Pre-carga el input (ej. el total de Shopify desde el chip de sobreprecio). */
  suggested?: number;
  onSuccess?: () => void;
}

// Cambia el VALOR a cobrar (COD) del pedido en Dropi vía la edge function
// dropi-change-carrier (mode "apply_value"). El server intenta primero el
// cambio directo (PUT verificado); si Dropi lo ignora, recrea el pedido como
// hace el panel (nuevo ID, misma transportadora). Solo pedidos sin guía.
export default function ChangeValueDialog({ open, onOpenChange, order, suggested, onSuccess }: Props) {
  const [raw, setRaw] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (open) setRaw(suggested != null ? String(suggested) : '');
  }, [open, suggested]);

  const parsed = parseValorInput(raw);
  const currentValor = Number(order.valor) || 0;
  const valid = parsed != null && parsed > 0;
  const isSame = valid && Math.abs((parsed as number) - currentValor) < 0.01;

  const handleApply = async () => {
    if (!valid || !order.externalId) return;
    setApplying(true);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-change-carrier', {
        body: { externalId: order.externalId, mode: 'apply_value', newValor: parsed },
      });
      const d = (data as ApplyValueResponse | null) ?? null;
      if (error && !d) {
        toast.error('No se pudo cambiar el valor: ' + (error instanceof Error ? error.message : 'error de red'));
        return;
      }
      if (!d?.ok) {
        const shortMsg = d?.error || 'Error desconocido';
        toast.error('Dropi no aceptó el cambio de valor', {
          description: (
            <div className="space-y-2">
              <p className="text-xs">{shortMsg}</p>
              {(d?.dropiHttpStatus !== undefined || d?.dropiBody !== undefined) && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold">Detalle técnico</summary>
                  <pre className="font-mono text-[11px] mt-1 p-2 bg-muted/40 rounded border border-border whitespace-pre-wrap break-all max-h-48 overflow-auto">
{`HTTP ${d?.dropiHttpStatus ?? 'n/a'}\n\n${JSON.stringify(d?.dropiBody ?? {}, null, 2)}`}
                  </pre>
                </details>
              )}
            </div>
          ),
          duration: 15000,
        });
        return;
      }
      // Guard de versión: si el server aún corre la función VIEJA (Lovable no
      // auto-redeploya), mode "apply_value" cae al modo quote y devuelve ok:true
      // con options pero SIN valorApplied — no se aplicó nada.
      if (d.valorApplied !== true) {
        toast.error('La función del servidor está desactualizada: no aplicó el valor. Pedí el redeploy de dropi-change-carrier en Lovable.');
        return;
      }
      if (d.method === 'recreate') {
        toast.success(`Valor cambiado a ${formatCOP(d.valor ?? parsed!)} — el pedido quedó con ID nuevo #${d.externalId}`);
      } else {
        toast.success(`Valor cambiado a ${formatCOP(d.valor ?? parsed!)}`);
      }
      if (d.warning) toast.warning(d.warning, { duration: 12000 });
      onSuccess?.();
      onOpenChange(false);
    } catch (e) {
      toast.error('No se pudo cambiar el valor: ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
              <DollarSign size={18} className="text-amber-500" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle className="text-lg">Cambiar valor a cobrar</DialogTitle>
              <DialogDescription className="text-xs">
                Actual: <strong>{formatCOP(currentValor)}</strong> · se sincroniza con Dropi
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-valor" className="text-xs">Nuevo valor</Label>
            <Input
              id="new-valor"
              inputMode="decimal"
              autoFocus
              value={raw}
              onChange={e => setRaw(e.target.value)}
              placeholder="Ej: 59.900 o 26,99"
            />
            {valid && !isSame && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                {formatCOP(currentValor)} <ArrowRight size={11} aria-hidden="true" />{' '}
                <span className="font-semibold text-foreground">{formatCOP(parsed as number)}</span>
              </p>
            )}
            {raw && !valid && (
              <p className="text-xs text-destructive">Escribí un número válido mayor a 0.</p>
            )}
            {isSame && (
              <p className="text-xs text-muted-foreground">Es el mismo valor actual.</p>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Primero se intenta el cambio directo en Dropi. Si Dropi lo ignora, el pedido
            se recrea con el valor nuevo y queda con un ID nuevo (igual que al cambiar
            transportadora) — el CRM actualiza la misma ficha, sin duplicados. Solo para
            pedidos sin guía.
          </p>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applying}>
            Cancelar
          </Button>
          <Button
            onClick={handleApply}
            disabled={!valid || isSame || applying}
            className="bg-amber-500 hover:bg-amber-600 text-white font-semibold"
          >
            {applying && <Loader2 size={14} className="mr-2 animate-spin" aria-hidden="true" />}
            Aplicar cambio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
