import { useEffect, useState } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCOP } from '@/lib/utils';
import { parseValorInput } from '@/lib/orderAlerts';
import { useGuardarRendicion } from '@/hooks/useBalanceRendiciones';
import type { Rendicion } from '@/lib/balanceRendiciones';

// Carga de una rendición: el retiro (cuánto salió de la billetera) y los
// comprobantes que lo justifican. Owner-only, igual que la RPC.
//
// El total de los comprobantes se suma EN VIVO contra el monto retirado y la
// diferencia se muestra mientras se escribe: si al terminar de cargar no cuadra,
// se ve ahí y no tres semanas después. Es lo único que hace este formulario que
// una planilla no hacía.

interface ItemForm {
  fecha: string;
  concepto: string;
  monto: string;      // string mientras se escribe: un `number` fuerza 0 y "0" y
                      // "vacío" se ven igual en un input de plata
  plataforma: string;
}

const ITEM_VACIO: ItemForm = { fecha: '', concepto: '', monto: '', plataforma: 'meta' };
const hoy = () => new Date().toLocaleDateString('en-CA');

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Rendición existente a editar; `null` = una nueva. */
  editando: Rendicion | null;
}

export default function RendicionDialog({ open, onOpenChange, editando }: Props) {
  const guardar = useGuardarRendicion();
  const [fecha, setFecha] = useState(hoy());
  const [responsable, setResponsable] = useState('');
  const [montoRetirado, setMontoRetirado] = useState('');
  const [notas, setNotas] = useState('');
  const [items, setItems] = useState<ItemForm[]>([{ ...ITEM_VACIO }]);

  // Recarga el formulario cada vez que se abre. Sin esto, abrir una rendición,
  // cerrar y abrir OTRA mostraba los datos de la primera.
  useEffect(() => {
    if (!open) return;
    if (editando) {
      setFecha(editando.fecha);
      setResponsable(editando.responsable ?? '');
      setMontoRetirado(String(editando.monto_retirado ?? ''));
      setNotas(editando.notas ?? '');
      setItems(
        editando.items.length
          ? editando.items.map((i) => ({
              fecha: i.fecha ?? '',
              concepto: i.concepto,
              monto: String(i.monto),
              plataforma: i.plataforma ?? 'otro',
            }))
          : [{ ...ITEM_VACIO }],
      );
    } else {
      setFecha(hoy());
      setResponsable('');
      setMontoRetirado('');
      setNotas('');
      setItems([{ ...ITEM_VACIO }]);
    }
  }, [open, editando]);

  // parseValorInput y no Number a secas: "59.900" (miles CO) con Number da
  // 59,9 y "1,500" da 1,5 — el monto CORRUPTO se guardaba vía upsert_rendicion
  // y contaminaba "Sin explicar" y el cruce de duplicados del Balance. Es la
  // CUARTA aparición del mismo bug de parseo de plata (pauta dialog, simulador,
  // costos admin, acá) — siempre parseValorInput.
  const nItem = (s: string) => parseValorInput(String(s)) ?? 0;
  /**
   * ⛔ EL CUADRE SE CALCULA SOBRE LO QUE SE VA A GUARDAR (4-sep-2026).
   *
   * `totalItems` sumaba TODOS los renglones, pero al guardar solo viajan los que
   * tienen concepto (`itemsValidos`, abajo y en `onSubmit`). Un comprobante al
   * que se le olvidó escribir el concepto hacía que el diálogo dijera "cuadra
   * exacto" y la rendición se guardara CORTA por ese monto — y esa diferencia
   * reaparecía días después en "Sin explicar" del Balance, sin que nadie
   * supiera de dónde había salido. Plata que se busca a mano.
   */
  const itemsValidos = items.filter((i) => i.concepto.trim() !== '');
  const totalItems = itemsValidos.reduce((a, i) => a + nItem(i.monto), 0);
  /** Renglones con monto pero sin concepto: NO se guardan y hay que decirlo. */
  const itemsSinConcepto = items.filter((i) => i.concepto.trim() === '' && nItem(i.monto) !== 0);
  const montoSinConcepto = itemsSinConcepto.reduce((a, i) => a + nItem(i.monto), 0);
  const retirado = nItem(montoRetirado);
  const diferencia = retirado - totalItems;
  const puedeGuardar = fecha !== '' && itemsValidos.length > 0 && !guardar.isPending;

  const setItem = (idx: number, campo: keyof ItemForm, valor: string) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [campo]: valor } : it)));

  const onSubmit = () => {
    guardar.mutate(
      {
        id: editando?.id ?? null,
        fecha,
        responsable,
        monto_retirado: retirado,
        notas,
        items: itemsValidos.map((i) => ({
          fecha: i.fecha || null,
          concepto: i.concepto.trim(),
          monto: nItem(i.monto),
          plataforma: i.plataforma || null,
        })),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editando ? 'Editar rendición' : 'Nueva rendición'}</DialogTitle>
          <DialogDescription>
            Cuánto salió de la billetera y en qué se gastó. Los comprobantes se cruzan
            solos contra las rendiciones anteriores para avisar si un cargo se repite.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rend-fecha">Fecha del retiro</Label>
              <Input id="rend-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rend-resp">Quién rindió</Label>
              <Input
                id="rend-resp" value={responsable} placeholder="Nombre"
                onChange={(e) => setResponsable(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rend-monto">Monto retirado</Label>
              <Input
                id="rend-monto" inputMode="decimal" value={montoRetirado} placeholder="0"
                onChange={(e) => setMontoRetirado(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Comprobantes</Label>
              <Button
                type="button" size="sm" variant="outline"
                onClick={() => setItems((p) => [...p, { ...ITEM_VACIO }])}
              >
                <Plus size={13} className="mr-1.5" /> Agregar
              </Button>
            </div>

            <div className="space-y-2">
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <Input
                    className="col-span-3" type="date" value={it.fecha}
                    aria-label={`Fecha del comprobante ${idx + 1}`}
                    onChange={(e) => setItem(idx, 'fecha', e.target.value)}
                  />
                  <Input
                    className="col-span-4" value={it.concepto} placeholder="Concepto"
                    aria-label={`Concepto del comprobante ${idx + 1}`}
                    onChange={(e) => setItem(idx, 'concepto', e.target.value)}
                  />
                  <Input
                    className="col-span-2" inputMode="decimal" value={it.monto} placeholder="0"
                    aria-label={`Monto del comprobante ${idx + 1}`}
                    onChange={(e) => setItem(idx, 'monto', e.target.value)}
                  />
                  <select
                    className="col-span-2 h-10 rounded-md border border-border bg-background px-2 text-xs"
                    value={it.plataforma}
                    aria-label={`Plataforma del comprobante ${idx + 1}`}
                    onChange={(e) => setItem(idx, 'plataforma', e.target.value)}
                  >
                    <option value="meta">Meta</option>
                    <option value="tiktok">TikTok</option>
                    <option value="otro">Otro</option>
                  </select>
                  <Button
                    type="button" size="icon" variant="ghost"
                    className="col-span-1 h-10 w-10 text-muted-foreground hover:text-danger"
                    aria-label={`Quitar el comprobante ${idx + 1}`}
                    // Nunca se queda sin filas: con cero, el formulario parece roto
                    // y no hay dónde volver a escribir.
                    onClick={() => setItems((p) => (p.length > 1 ? p.filter((_, i) => i !== idx) : [{ ...ITEM_VACIO }]))}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* El cuadre EN VIVO. Es la razón de ser del formulario: si no cuadra,
              se ve mientras se carga y no semanas después. */}
          <div className={`rounded-xl border p-3 text-sm ${
            Math.abs(diferencia) < 0.01
              ? 'border-success/30 bg-success/8'
              : 'border-warning/40 bg-warning/8'
          }`}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Comprobantes cargados</span>
              <span className="font-mono tabular-nums">{formatCOP(totalItems)}</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-muted-foreground text-xs">Retirado</span>
              <span className="font-mono tabular-nums">{formatCOP(retirado)}</span>
            </div>
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-border font-semibold">
              <span className="flex items-center gap-1.5">
                {Math.abs(diferencia) >= 0.01 && <AlertTriangle size={13} className="text-warning" />}
                {diferencia > 0 ? 'Falta justificar' : diferencia < 0 ? 'Rendido de más' : 'Cuadra exacto'}
              </span>
              <span className="font-mono tabular-nums">
                {Math.abs(diferencia) < 0.01 ? '—' : formatCOP(Math.abs(diferencia))}
              </span>
            </div>
            {/* Un renglón con monto y sin concepto NO se guarda (ver `itemsValidos`).
                Antes entraba igual al cuadre de esta caja y desaparecía al grabar:
                el diálogo decía "cuadra exacto" y la rendición nacía corta. */}
            {itemsSinConcepto.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border text-[11px] text-warning flex items-start gap-1.5">
                <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  {itemsSinConcepto.length === 1
                    ? `Hay 1 comprobante de ${formatCOP(montoSinConcepto)} SIN concepto: no se va a guardar.`
                    : `Hay ${itemsSinConcepto.length} comprobantes por ${formatCOP(montoSinConcepto)} SIN concepto: no se van a guardar.`}
                  {' '}Escribí el concepto o borrá el renglón.
                </span>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rend-notas">Notas</Label>
            <Textarea
              id="rend-notas" rows={2} value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Opcional"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={onSubmit} disabled={!puedeGuardar}>
            {guardar.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
