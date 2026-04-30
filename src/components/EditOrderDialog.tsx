import { useState, useMemo, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { OrderData } from '@/lib/orderUtils';
import { DEPARTAMENTOS_NOMBRES, getCiudadesDe } from '@/lib/colombiaGeo';
import { useAuth } from '@/contexts/AuthContext';
import { AddressAutocomplete } from '@/components/address/AddressAutocomplete';
import { AddressFeedbackCard } from '@/components/address/AddressFeedbackCard';
import { toast } from 'sonner';
import { Loader2, User, MapPin, Pencil } from 'lucide-react';

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
  // Pre-populate every field from the current order. Email now lives on
  // OrderData so it survives the hop through dbToOrderData.
  // Validador-direcciones: el form también arrastra los campos de dirección
  // estructurada (barrio/lat/lng/place_id/addressKind) y la decisión de
  // validación. Los inputs de Dropi siguen mandando solo direccion+ciudad,
  // pero AddressAutocomplete los actualiza para reflejar el nuevo estado en
  // AddressFeedbackCard sin esperar el round-trip a la edge function.
  const initial = useMemo(() => {
    const { nombre, apellido } = splitName(order.nombre);
    return {
      nombre,
      apellido,
      phone: (order.phone || '').replace(/\D/g, ''),
      departamento: order.departamento || '',
      ciudad: order.ciudad || '',
      direccion: order.direccion || '',
      email: order.email || '',
      barrio: '' as string | undefined,
      googlePlaceId: order.googlePlaceId || ('' as string | undefined),
      lat: undefined as number | null | undefined,
      lng: undefined as number | null | undefined,
      addressKind: order.addressKind ?? null,
      validationDecision: order.validationDecision,
      missingFields: order.missingFields ?? [],
      suggestedCustomerMessage: order.suggestedCustomerMessage ?? '',
      transportadora: order.transportadora || '',
    };
  }, [order]);

  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the dialog opens with a (possibly different) order
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  // Build depto option list. If the order's depto matches the canonical
  // list case-insensitively (e.g. DB has "ANTIOQUIA", canonical is
  // "Antioquia"), normalize the form value to the canonical casing so the
  // Select can find its <SelectItem> and show it. Otherwise prepend the raw
  // value as an extra option to avoid losing data.
  const deptoOptions = useMemo(() => {
    const list = [...DEPARTAMENTOS_NOMBRES];
    if (!form.departamento) return list;
    const canonical = list.find(d => d.toLowerCase() === form.departamento.toLowerCase());
    if (!canonical) list.unshift(form.departamento);
    return list;
  }, [form.departamento]);

  // Auto-normalize departamento casing once on mount so the Select binds.
  useEffect(() => {
    if (!form.departamento) return;
    const canonical = DEPARTAMENTOS_NOMBRES.find(
      d => d.toLowerCase() === form.departamento.toLowerCase(),
    );
    if (canonical && canonical !== form.departamento) {
      setForm(f => ({ ...f, departamento: canonical }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.departamento]);

  const ciudades = useMemo(() => getCiudadesDe(form.departamento), [form.departamento]);

  // Same trick for ciudad: normalize to canonical casing if there's a
  // case-insensitive match, otherwise surface raw value as extra option.
  const ciudadOptions = useMemo(() => {
    const list = [...ciudades];
    if (!form.ciudad) return list;
    const canonical = list.find(c => c.toLowerCase() === form.ciudad.toLowerCase());
    if (!canonical) list.unshift(form.ciudad);
    return list;
  }, [ciudades, form.ciudad]);

  useEffect(() => {
    if (!form.ciudad || !ciudades.length) return;
    const canonical = ciudades.find(c => c.toLowerCase() === form.ciudad.toLowerCase());
    if (canonical && canonical !== form.ciudad) {
      setForm(f => ({ ...f, ciudad: canonical }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ciudades]);

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
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Pencil size={18} className="text-primary" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle className="text-lg">Editar orden</DialogTitle>
              <DialogDescription className="text-xs">
                Los cambios se sincronizan con Dropi automáticamente
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* ---- Información del cliente ---- */}
          <section className="space-y-3">
            <header className="flex items-center gap-2 pb-2 border-b border-border">
              <User size={14} className="text-muted-foreground" aria-hidden="true" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Información del cliente
              </h3>
            </header>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-nombre" className="text-xs">Nombre *</Label>
                <Input
                  id="edit-nombre"
                  value={form.nombre}
                  onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-apellido" className="text-xs">Apellido</Label>
                <Input
                  id="edit-apellido"
                  value={form.apellido}
                  onChange={e => setForm(f => ({ ...f, apellido: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-phone" className="text-xs">Teléfono (solo dígitos)</Label>
                <Input
                  id="edit-phone"
                  inputMode="numeric"
                  value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 15) }))}
                  placeholder="573001234567"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-email" className="text-xs">Email (opcional)</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="cliente@ejemplo.com"
                />
              </div>
            </div>
          </section>

          {/* ---- Dirección de entrega ---- */}
          <section className="space-y-3">
            <header className="flex items-center gap-2 pb-2 border-b border-border">
              <MapPin size={14} className="text-muted-foreground" aria-hidden="true" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Dirección de entrega
              </h3>
            </header>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Departamento *</Label>
                <Select
                  value={form.departamento || undefined}
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

              <div className="space-y-1.5">
                <Label className="text-xs">Ciudad *</Label>
                <Select
                  value={form.ciudad || undefined}
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

              <div className="md:col-span-2 space-y-2">
                <Label htmlFor="edit-direccion" className="text-xs">Dirección *</Label>
                {/* Validador-direcciones v2: autocomplete de Google Places +
                    cache de cliente recurrente. Si el operador escribe libre,
                    queda en source=free_write y la edge function de validación
                    seguirá generando feedback. */}
                <AddressAutocomplete
                  value={form.direccion}
                  ciudad={form.ciudad}
                  customerPhone={form.phone}
                  onChange={(update) => {
                    setForm(prev => ({
                      ...prev,
                      direccion: update.direccion,
                      ...(update.barrio !== undefined ? { barrio: update.barrio } : {}),
                      ...(update.place_id !== undefined ? { googlePlaceId: update.place_id } : {}),
                      ...(update.lat !== undefined ? { lat: update.lat } : {}),
                      ...(update.lng !== undefined ? { lng: update.lng } : {}),
                      addressKind: update.address_kind,
                      ...(update.source === 'autocomplete' || update.source === 'recurrent_customer' ? {
                        validationDecision: 'green' as const,
                        missingFields: [] as string[],
                        suggestedCustomerMessage: '',
                      } : {}),
                    }));
                  }}
                />
                <AddressFeedbackCard
                  decision={form.validationDecision}
                  missingFields={form.missingFields ?? []}
                  suggestedMessage={form.suggestedCustomerMessage ?? ''}
                  isAdmin={isAdmin}
                  carrier={form.transportadora}
                  onOverrideChange={() => { /* EditOrderDialog no aplica gate */ }}
                />
              </div>
            </div>
          </section>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            size="lg"
            className="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-6"
          >
            {submitting && <Loader2 size={14} className="mr-2 animate-spin" aria-hidden="true" />}
            Actualizar Orden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
