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
import { bogotaToday, paisUsaCentavos } from '@/lib/utils';
import { parseValorInput } from '@/lib/orderAlerts';
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
  /** Rango visible en la pantalla — para avisar si lo guardado queda fuera. */
  visibleFrom?: string;
  visibleTo?: string;
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

/** "sáb 23 ago" — para que la fecha elegida se LEA, no solo se parsee. */
function fmtDiaLargo(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short' });
}

export default function StoreAdSpendDialog({
  open, onOpenChange, editing, visibleFrom, visibleTo,
}: Props) {
  const { activeStoreId, activeStore } = useStore();
  const upsert = useUpsertStoreAdSpend();
  const del = useDeleteStoreAdSpend();

  const [spendDate, setSpendDate] = useState(yesterdayBogota());
  const [platform, setPlatform] = useState<AdPlatform>('meta');
  const [amount, setAmount] = useState('');
  const [notas, setNotas] = useState('');

  const currencyLabel = activeStore?.country_code === 'EC' ? 'USD'
    : activeStore?.country_code === 'GT' ? 'GTQ'
    : 'COP';

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

  // Parse tolerante a formatos locales ("45,50" EC · "59.900" miles CO) con el
  // MISMO parser del editor de pedidos. El strip "solo dígitos" que había acá
  // convertía "45.50" en 4550 (100x) en tiendas con centavos (EC/GT) y ese
  // monto inflado alimentaba CPA/Neto Real/DEJA — plata falsa en los KPIs.
  const usaCentavos = paisUsaCentavos(activeStore?.country_code);
  const parseAmount = (v: string): number | null => {
    const n = parseValorInput(v);
    if (n == null || n < 0) return null;
    return usaCentavos ? Math.round(n * 100) / 100 : Math.round(n);
  };

  const handleSubmit = async () => {
    if (!activeStoreId) { toast.error('Sin tienda activa'); return; }
    if (!spendDate) { toast.error('Elegí una fecha'); return; }
    const amt = parseAmount(amount);
    if (amt == null) { toast.error('Monto inválido — revisá el número'); return; }
    try {
      await upsert.mutateAsync({
        store_id: activeStoreId,
        spend_date: spendDate,
        platform,
        amount: amt,
        notas: notas.trim(),
      });
      // La fecha guardada VA en el toast: el default es AYER y más de una vez
      // el registro "desaparecía" porque cayó en un día que no era el esperado
      // o fuera del rango filtrado — se dice, no se deja adivinar.
      toast.success(`Pauta guardada para el ${fmtDiaLargo(spendDate)}`);
      if (visibleFrom && visibleTo && (spendDate < visibleFrom || spendDate > visibleTo)) {
        toast.info(
          `Ojo: el ${fmtDiaLargo(spendDate)} queda FUERA del rango que estás mirando — no la vas a ver en la tabla hasta ampliar las fechas.`,
          { duration: 8000 },
        );
      }
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
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="ad-date" className="text-xs">Fecha</Label>
                {/* Atajos Hoy/Ayer: el default silencioso en AYER hacía que un
                    registro de "hoy" cayera un día atrás sin que se notara. */}
                <span className="inline-flex gap-1">
                  {([['Hoy', bogotaToday()], ['Ayer', yesterdayBogota()]] as const).map(([lbl, d]) => (
                    <button
                      key={lbl}
                      type="button"
                      onClick={() => setSpendDate(d)}
                      className={`px-2 py-0.5 rounded-lg border text-[10px] font-medium transition-colors ${
                        spendDate === d
                          ? 'border-accent/40 bg-accent/15 text-accent'
                          : 'border-border text-muted-foreground hover:text-foreground hover:border-border-strong'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </span>
              </div>
              <Input
                id="ad-date"
                type="date"
                value={spendDate}
                onChange={(e) => setSpendDate(e.target.value)}
              />
              {/* La fecha LEÍDA ("vie 22 ago") al lado del input: es la defensa
                  contra guardar en el día equivocado. */}
              <span className="block text-[10px] text-muted-foreground">
                Se guarda para el <strong className="text-foreground">{fmtDiaLargo(spendDate)}</strong>
              </span>
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
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={usaCentavos ? '45.50' : '0'}
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
