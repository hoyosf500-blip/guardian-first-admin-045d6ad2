import { useState, useMemo, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { OrderData } from '@/lib/orderUtils';
import { DEPARTAMENTOS_NOMBRES, getCiudadesDe } from '@/lib/colombiaGeo';
import { toast } from 'sonner';
import { Loader2, User, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderData;
  onSuccess?: () => void;
}

// Split a stored full name into first + last for the form. Naive but
// reversible: first token = nombre, rest = apellido.
function splitName(full: string): { nombre: string; apellido: string } {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { nombre: parts[0] || '', apellido: '' };
  return { nombre: parts[0], apellido: parts.slice(1).join(' ') };
}

export default function EditOrderDialog({ open, onOpenChange, order, onSuccess }: Props) {
  const { isAdmin } = useAuth();
  const initial = useMemo(() => {
    const { nombre, apellido } = splitName(order.nombre);
    return {
      nombre,
      apellido,
      phone: (order.phone || '').replace(/\D/g, ''),
      departamento: order.departamento || '',
      ciudad: order.ciudad || '',
      direccion: order.direccion || '',
      email: '',
    };
  }, [order]);

  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the dialog opens with a (possibly different) order
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  const ciudades = useMemo(() => getCiudadesDe(form.departamento), [form.departamento]);

  // If current ciudad isn't in the new departamento's list, surface it as
  // an extra option so the operator doesn't lose the value silently.
  const ciudadOptions = useMemo(() => {
    const list = [...ciudades];
    if (form.ciudad && !list.some(c => c.toLowerCase() === form.ciudad.toLowerCase())) {
      list.unshift(form.ciudad);
    }
    return list;
  }, [ciudades, form.ciudad]);

  // If current departamento isn't in the canonical list, prepend it
  const deptoOptions = useMemo(() => {
    const list = [...DEPARTAMENTOS_NOMBRES];
    if (form.departamento && !list.some(d => d.toLowerCase() === form.departamento.toLowerCase())) {
      list.unshift(form.departamento);
    }
    return list;
  }, [form.departamento]);

  const handleSubmit = async () => {
    if (!order.externalId) {
      toast.error('Este pedido no tiene ID externo de Dropi y no puede sincronizarse');
      return;
    }
    if (!form.nombre.trim()) return toast.error('Nombre obligatorio');
    if (!form.direccion.trim()) return toast.error('Dirección obligatoria');
    if (!form.ciudad.trim()) return toast.error('Ciudad obligatoria');
    if (!form.departamento.trim()) return toast.error('Departamento obligatorio');
    if (form.phone && (form.phone.length < 7 || form.phone.length > 15)) {
      return toast.error('Teléfono inválido (7-15 dígitos)');
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      return toast.error('Email inválido');
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-update-order-full', {
        body: {
          externalId: order.externalId,
          nombre: form.nombre.trim(),
          apellido: form.apellido.trim(),
          phone: form.phone,
          ciudad: form.ciudad.trim(),
          departamento: form.departamento.trim(),
          direccion: form.direccion.trim(),
          email: form.email.trim(),
        },
      });

      // Edge function returned an explicit Dropi failure (ok:false with detail).
      // Show enriched toast with collapsible technical details so we can copy
      // the exact error and iterate.
      const dropiHttpStatus = (data as { dropiHttpStatus?: number } | null)?.dropiHttpStatus;
      const dropiBody = (data as { dropiBody?: unknown } | null)?.dropiBody;
      const isDropiFailure =
        (data && (data as { ok?: boolean }).ok === false) ||
        (typeof dropiHttpStatus === 'number' && dropiHttpStatus >= 400);

      if (error || isDropiFailure) {
        const shortMsg =
          (data as { error?: string } | null)?.error ||
          (error instanceof Error ? error.message : 'Error desconocido');
        toast.error('Dropi rechazó el cambio', {
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
        return; // do not close dialog; keep operator's edits
      }

      if ((data as { noChange?: boolean } | null)?.noChange) {
        toast.info('No había cambios que sincronizar');
      } else {
        toast.success('Orden actualizada y sincronizada con Dropi');
      }
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      toast.error('No se pudo actualizar: ' + msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
              <User size={18} className="text-emerald-500" />
            </div>
            <div>
              <DialogTitle>Editar orden</DialogTitle>
              <DialogDescription>Información del cliente — se sincroniza con Dropi</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
          <div>
            <Label htmlFor="edit-nombre">Nombre *</Label>
            <Input id="edit-nombre" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="edit-apellido">Apellido</Label>
            <Input id="edit-apellido" value={form.apellido} onChange={e => setForm(f => ({ ...f, apellido: e.target.value }))} />
          </div>

          <div className="md:col-span-2">
            <Label htmlFor="edit-phone">Teléfono (solo dígitos)</Label>
            <Input
              id="edit-phone"
              inputMode="numeric"
              value={form.phone}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 15) }))}
              placeholder="573001234567"
            />
          </div>

          <div>
            <Label>Departamento *</Label>
            <Select
              value={form.departamento}
              onValueChange={(v) => setForm(f => ({ ...f, departamento: v, ciudad: '' }))}
            >
              <SelectTrigger><SelectValue placeholder="Seleccionar..." /></SelectTrigger>
              <SelectContent>
                {deptoOptions.map(d => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Ciudad *</Label>
            <Select
              value={form.ciudad}
              onValueChange={(v) => setForm(f => ({ ...f, ciudad: v }))}
              disabled={!form.departamento}
            >
              <SelectTrigger>
                <SelectValue placeholder={form.departamento ? 'Seleccionar...' : 'Elige depto. primero'} />
              </SelectTrigger>
              <SelectContent>
                {ciudadOptions.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-2">
            <Label htmlFor="edit-direccion">Dirección *</Label>
            <Input id="edit-direccion" value={form.direccion} onChange={e => setForm(f => ({ ...f, direccion: e.target.value }))} />
          </div>

          <div className="md:col-span-2">
            <Label htmlFor="edit-email">Email (opcional)</Label>
            <Input id="edit-email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="cliente@ejemplo.com" />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-orange-500 hover:bg-orange-600 text-white"
          >
            {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
            Actualizar Orden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
