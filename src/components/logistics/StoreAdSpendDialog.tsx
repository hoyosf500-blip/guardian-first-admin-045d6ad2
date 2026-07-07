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
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import {
  useUpsertStoreAdSpend, useDeleteStoreAdSpend,
  type AdPlatform, type StoreAdSpendRow,
} from '@/hooks/useStoreAdSpend';

// Carga diaria de pauta por canal. Una fila = un canal en un día con su monto.
// Default de fecha = AYER (el caso típico: "ayer gasté X"). Upsert por (día, canal).

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: StoreAdSpendRow | null;   // null = creando
}

const PLATFORMS: { value: AdPlatform; label: string }[] = [
  { value: 'meta', label: 'Meta (Facebook / Instagram)' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'other', label: 'Otro' },
];

/** Ayer en zona Bogotá (YYYY-MM-DD). Mediodía UTC para evitar bordes de TZ/DST. */
function yesterdayBogota(): string {
  const d = new Date(`${bogotaToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function StoreAdSpendDialog({ open, onOpenChange, editing }: Props) {
  const { activeStoreId, activeStore } = useStore();
  const upsert = useUpsertStoreAdSpend();
  const del = useDeleteStoreAdSpend();

  const [spendDate, setSpendDate] = useState(yesterdayBogota());
  const [platform, setPlatform] = useState<AdPlatform>('meta');
  const [amount, setAmount] = useState('');
  const [notas, setNotas] = useState('');

  const currencyLabel = activeStore?.country_code === 'EC' ? 'USD' : 'COP';

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setSpendDate(editing.spend_date);
      setPlatform(editing.platform);
      setAmount(String(editing.amount));
      setNotas(editing.notas ?? '');
    } else {
      setSpendDate(yesterdayBogota());
      setPlatform('meta');
      setAmount('');
      setNotas('');
    }
  }, [open, editing]);

  // Enteros: se strippean separadores (consistente con el resto de la app, sin centavos).
  const parseAmount = (v: string): number => {
    const clean = v.replace(/[^\d]/g, '');
    const n = Number(clean);
    return isFinite(n) && n >= 0 ? n : 0;
  };

  const handleSubmit = async () => {
    if (!activeStoreId) { toast.error('Sin tienda activa'); return; }
    if (!spendDate) { toast.error('Elegí una fecha'); return; }
    const amt = parseAmount(amount);
    try {
      await upsert.mutateAsync({
        store_id: activeStoreId,
        spend_date: spendDate,
        platform,
        amount: amt,
        notas: notas.trim(),
      });
      toast.success('Pauta guardada');
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      toast.error(`No se pudo guardar: ${msg}`);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    if (!window.confirm('¿Eliminar este registro de pauta?')) return;
    try {
      await del.mutateAsync(editing.id);
      toast.success('Registro eliminado');
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
          <DialogTitle>{editing ? 'Editar pauta del día' : 'Registrar pauta del día'}</DialogTitle>
          <DialogDescription className="text-xs">
            Cuánto gastaste ese día en cada canal. Un monto por canal por día — si te
            equivocaste, lo editás y se sobreescribe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ad-date" className="text-xs">Fecha</Label>
              <Input
                id="ad-date"
                type="date"
                value={spendDate}
                onChange={(e) => setSpendDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Canal</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as AdPlatform)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ad-amount" className="text-xs">Monto ({currencyLabel})</Label>
            <Input
              id="ad-amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ad-notas" className="text-xs">Nota (opcional)</Label>
            <Textarea
              id="ad-notas"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="cuenta, campaña, observación…"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="flex flex-row sm:justify-between gap-2">
          {editing ? (
            <Button
              type="button" variant="outline" onClick={handleDelete} disabled={busy}
              className="text-red border-red/40 hover:bg-red/5"
            >
              <Trash2 size={14} className="mr-1.5" /> Eliminar
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
