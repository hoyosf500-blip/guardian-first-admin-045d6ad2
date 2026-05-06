import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  useUpsertAdSpend, useDeleteAdSpend,
  type AdPlatform, type AdPaymentMethod, type AdSpendRow,
} from '@/hooks/useMonthlyAdSpend';

// Modal para agregar / editar / eliminar una fila de pauta.
// Una fila = una cuenta de Meta/TikTok en un mes específico con su
// monto total y método de pago.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yearMonth: string;                  // 'YYYY-MM' del contexto activo
  editing: AdSpendRow | null;         // null = creando nueva fila
}

const PLATFORMS: { value: AdPlatform; label: string }[] = [
  { value: 'meta', label: 'Meta Ads' },
  { value: 'tiktok', label: 'TikTok Ads' },
  { value: 'other', label: 'Otro' },
];

const PAYMENT_METHODS: { value: AdPaymentMethod; label: string; tone: string }[] = [
  { value: 'mastercard_usd', label: 'Mastercard USD (se difiere)', tone: 'text-red' },
  { value: 'mastercard_cop', label: 'Mastercard pesos', tone: 'text-foreground' },
  { value: 'amex_cop', label: 'Amex pesos (no se difiere)', tone: 'text-green' },
  { value: 'wallet', label: 'Wallet directo', tone: 'text-green' },
  { value: 'other', label: 'Otro', tone: 'text-muted-foreground' },
];

export default function CfoAdSpendDialog({ open, onOpenChange, yearMonth, editing }: Props) {
  const upsert = useUpsertAdSpend();
  const del = useDeleteAdSpend();

  const [platform, setPlatform] = useState<AdPlatform>('meta');
  const [accountName, setAccountName] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<AdPaymentMethod>('mastercard_usd');
  const [notas, setNotas] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setPlatform(editing.platform);
      setAccountName(editing.account_name);
      setAmount(String(editing.amount_cop));
      setPaymentMethod(editing.payment_method);
      setNotas(editing.notas ?? '');
    } else {
      setPlatform('meta');
      setAccountName('');
      setAmount('');
      setPaymentMethod('mastercard_usd');
      setNotas('');
    }
  }, [open, editing]);

  const parseAmount = (v: string): number => {
    const clean = v.replace(/[^\d.,]/g, '').replace(/[.,]/g, '');
    const n = Number(clean);
    return isFinite(n) && n >= 0 ? n : 0;
  };

  const handleSubmit = async () => {
    if (!accountName.trim()) {
      toast.error('Ingresa un nombre de cuenta');
      return;
    }
    const amt = parseAmount(amount);
    if (amt < 0) {
      toast.error('El monto no puede ser negativo');
      return;
    }
    try {
      await upsert.mutateAsync({
        year_month: yearMonth,
        platform,
        account_name: accountName.trim(),
        amount_cop: amt,
        payment_method: paymentMethod,
        notas: notas.trim(),
      });
      toast.success(`Pauta de ${accountName.trim()} guardada para ${yearMonth}`);
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      toast.error(`No se pudo guardar: ${msg}`);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    if (!window.confirm(`¿Eliminar la fila de ${editing.account_name} (${editing.year_month})?`)) return;
    try {
      await del.mutateAsync(editing.id);
      toast.success('Fila eliminada');
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      toast.error(`No se pudo eliminar: ${msg}`);
    }
  };

  const busy = upsert.isPending || del.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Editar pauta' : 'Agregar cuenta de pauta'} — {yearMonth}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Una fila por cuenta de Meta o TikTok con su gasto total del mes.
            El método de pago decide si la pauta se difiere o no.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Plataforma</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as AdPlatform)}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-amount" className="text-xs">Monto total mes (COP)</Label>
              <Input
                id="ad-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ad-account" className="text-xs">Nombre de la cuenta</Label>
            <Input
              id="ad-account"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="ej: CPP CLON 12, INSTITUTO SAN JUDAS TADEO"
              disabled={Boolean(editing)}
            />
            {editing && (
              <p className="text-[10px] text-muted-foreground">
                El nombre no se puede editar (es parte de la clave única). Si es otra cuenta, eliminá esta y creá una nueva.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Método de pago</Label>
            <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as AdPaymentMethod)}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="text-xs">
                    <span className={m.tone}>{m.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ad-notas" className="text-xs">Notas (opcional)</Label>
            <Textarea
              id="ad-notas"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="ROAS, observaciones, decisiones del mes…"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="flex flex-row sm:justify-between gap-2">
          {editing ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleDelete}
              disabled={busy}
              className="text-red border-red/40 hover:bg-red/5"
            >
              <Trash2 size={14} className="mr-1.5" />
              Eliminar
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={busy}>
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Guardando…
                </span>
              ) : 'Guardar'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
