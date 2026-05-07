import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  useUpsertMonthlyInputs,
  type MonthlyBusinessInputs,
} from '@/hooks/useCfoMonthlyInputs';

// Modal del bloque P&L de /cfo. 4 inputs numéricos + textarea de notas.
// Guarda via RPC upsert_monthly_business_inputs (idempotente por year_month).
// El botón guardar está deshabilitado mientras la mutación está en vuelo.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yearMonth: string;                            // 'YYYY-MM'
  current: MonthlyBusinessInputs | null;        // null si el mes no tiene inputs todavía
}

export default function CfoInputsDialog({ open, onOpenChange, yearMonth, current }: Props) {
  const upsert = useUpsertMonthlyInputs();

  // Form state — strings para no pelearse con el caret en inputs numéricos.
  const [adsMeta, setAdsMeta] = useState('');
  const [adsTiktok, setAdsTiktok] = useState('');
  const [tarjetaPago, setTarjetaPago] = useState('');
  const [tarjetaInteres, setTarjetaInteres] = useState('');
  const [notas, setNotas] = useState('');

  // Cuando abre o cambia el mes, sincronizar form con el row actual.
  useEffect(() => {
    if (!open) return;
    setAdsMeta(current?.ads_meta != null ? String(current.ads_meta) : '');
    setAdsTiktok(current?.ads_tiktok != null ? String(current.ads_tiktok) : '');
    setTarjetaPago(current?.tarjeta_pago != null ? String(current.tarjeta_pago) : '');
    setTarjetaInteres(current?.tarjeta_interes != null ? String(current.tarjeta_interes) : '');
    setNotas(current?.notas ?? '');
  }, [open, current]);

  const parseAmount = (v: string): number => {
    // Audit fix: el strip indiscriminado de [.,] convertía "1.5" en "15"
    // (data corruption silenciosa en montos decimales). Ahora solo
    // removemos separadores de miles — secuencias de [.,] seguidas de
    // exactamente 3 dígitos. Decimales se preservan: "1.5" → 1.5,
    // "1.500.000" → 1500000, "1,500,000.50" → 1500000.50.
    let clean = v.replace(/[^\d.,]/g, '');
    // Eliminar separadores de miles iterativamente: . o , seguidos de 3
    // dígitos donde el siguiente carácter es otro separador-miles válido,
    // un no-dígito, o fin de string. Hasta 5 iteraciones (cubre números
    // enormes tipo 1.000.000.000).
    for (let i = 0; i < 5; i++) {
      const next = clean.replace(/([.,])(\d{3})(?=[.,]\d{3}|\D|$)/, '$2');
      if (next === clean) break;
      clean = next;
    }
    // El último separador remanente es el decimal; normalizar coma a punto.
    clean = clean.replace(',', '.');
    const n = Number(clean);
    return isFinite(n) && n >= 0 ? n : 0;
  };

  const handleSubmit = async () => {
    try {
      await upsert.mutateAsync({
        year_month: yearMonth,
        ads_meta: parseAmount(adsMeta),
        ads_tiktok: parseAmount(adsTiktok),
        tarjeta_pago: parseAmount(tarjetaPago),
        tarjeta_interes: parseAmount(tarjetaInteres),
        notas: notas.trim(),
      });
      toast.success(`Inputs de ${yearMonth} guardados`);
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      toast.error(`No se pudo guardar: ${msg}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !upsert.isPending && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Inputs manuales — {yearMonth}</DialogTitle>
          <DialogDescription className="text-xs">
            Datos que NO vienen de Dropi. Se usan para calcular la utilidad neta real
            del mes. Las cifras son COP, sin separadores ni decimales.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfo-ads-meta" className="text-xs">Meta Ads (COP)</Label>
              <Input
                id="cfo-ads-meta"
                inputMode="numeric"
                value={adsMeta}
                onChange={(e) => setAdsMeta(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfo-ads-tiktok" className="text-xs">TikTok Ads (COP)</Label>
              <Input
                id="cfo-ads-tiktok"
                inputMode="numeric"
                value={adsTiktok}
                onChange={(e) => setAdsTiktok(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfo-tarjeta-pago" className="text-xs">Tarjeta — pago (COP)</Label>
              <Input
                id="cfo-tarjeta-pago"
                inputMode="numeric"
                value={tarjetaPago}
                onChange={(e) => setTarjetaPago(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfo-tarjeta-interes" className="text-xs">Tarjeta — intereses (COP)</Label>
              <Input
                id="cfo-tarjeta-interes"
                inputMode="numeric"
                value={tarjetaInteres}
                onChange={(e) => setTarjetaInteres(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cfo-notas" className="text-xs">Notas (opcional)</Label>
            <Textarea
              id="cfo-notas"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Contexto del mes, eventos especiales, etc."
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={upsert.isPending}
          >
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={upsert.isPending}>
            {upsert.isPending ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Guardando…
              </span>
            ) : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
