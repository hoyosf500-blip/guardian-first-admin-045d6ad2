import { useMemo, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { OrderData } from '@/lib/orderUtils';
import { DEPARTAMENTOS_NOMBRES, getCiudadesDe } from '@/lib/colombiaGeo';
import { PROVINCIAS_ECUADOR } from '@/lib/ecuadorGeo';
import { useStore } from '@/contexts/StoreContext';
import { AddressAutocomplete } from '@/components/address/AddressAutocomplete';
import { AddressFeedbackCard } from '@/components/address/AddressFeedbackCard';
import { User, MapPin } from 'lucide-react';

// Formulario de datos del cliente + dirección del editor unificado de orden.
// Migración 1:1 del viejo EditOrderDialog (mismos campos, misma normalización
// canónica de depto/ciudad, mismo AddressAutocomplete + AddressFeedbackCard) —
// ahora como componente CONTROLADO: el diálogo padre es dueño del estado para
// poder calcular dirty flags y orquestar el submit.

export interface CustomerFormState {
  nombre: string;
  apellido: string;
  phone: string;
  departamento: string;
  ciudad: string;
  direccion: string;
  email: string;
  barrio?: string;
  googlePlaceId?: string;
  lat?: number | null;
  lng?: number | null;
  addressKind: OrderData['addressKind'] | null;
  validationDecision: OrderData['validationDecision'];
  missingFields: string[];
  suggestedCustomerMessage: string;
  transportadora: string;
}

/** Split naive pero reversible: primer token = nombre, resto = apellido. */
export function splitName(full: string): { nombre: string; apellido: string } {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { nombre: parts[0] || '', apellido: '' };
  return { nombre: parts[0], apellido: parts.slice(1).join(' ') };
}

/** Estado inicial del form desde la OrderData actual (mismo mapeo que el viejo diálogo). */
export function buildCustomerInitial(order: OrderData): CustomerFormState {
  const { nombre, apellido } = splitName(order.nombre);
  return {
    nombre,
    apellido,
    phone: (order.phone || '').replace(/\D/g, ''),
    departamento: order.departamento || '',
    ciudad: order.ciudad || '',
    direccion: order.direccion || '',
    email: order.email || '',
    barrio: '',
    googlePlaceId: order.googlePlaceId || '',
    lat: undefined as number | null | undefined,
    lng: undefined as number | null | undefined,
    addressKind: order.addressKind ?? null,
    validationDecision: order.validationDecision,
    missingFields: order.missingFields ?? [],
    suggestedCustomerMessage: order.suggestedCustomerMessage ?? '',
    transportadora: order.transportadora || '',
  };
}

/** ¿Cambió algún campo que viaja a dropi-update-order-full? (espejo de su
 *  chequeo nothingChanged server-side). */
export function customerDirty(initial: CustomerFormState, form: CustomerFormState): boolean {
  return (
    initial.nombre.trim() !== form.nombre.trim() ||
    initial.apellido.trim() !== form.apellido.trim() ||
    initial.phone !== form.phone ||
    initial.departamento.trim() !== form.departamento.trim() ||
    initial.ciudad.trim() !== form.ciudad.trim() ||
    initial.direccion.trim() !== form.direccion.trim() ||
    initial.email.trim() !== form.email.trim()
  );
}

interface Props {
  value: CustomerFormState;
  onChange: (updater: (prev: CustomerFormState) => CustomerFormState) => void;
  isAdmin: boolean;
}

/**
 * Rótulo de campo — uno solo para las dos columnas del editor (acá y en
 * ProductLinesEditor, que iba en 10px sin mayúsculas y rompía la simetría).
 * Va en `muted-foreground` a propósito: el dato manda, el rótulo acompaña.
 * Esta es la pantalla donde la asesora le LEE la dirección al cliente por
 * teléfono, así que el valor tiene que ganarle al rótulo, no al revés.
 * NO se usa `.hud-label` acá: bajaría los rótulos a 10px y estos se leen a
 * diario desde el celular.
 */
const LABEL_CLS = 'text-xs uppercase tracking-wider text-muted-foreground';

export default function CustomerForm({ value: form, onChange, isAdmin }: Props) {
  // País de la tienda activa → el catálogo de geografía es country-aware.
  // Colombia usa el catálogo DANE (dropdown depto + ciudad); Ecuador usa las 24
  // provincias (con sugerencias) y la ciudad/cantón como texto libre.
  const { activeStore } = useStore();
  const isEC = (activeStore?.country_code || 'CO').toUpperCase() === 'EC';
  const DEPTOS = isEC ? PROVINCIAS_ECUADOR : DEPARTAMENTOS_NOMBRES;

  // Build depto option list. Si el depto del pedido matchea la lista canónica
  // case-insensitive, se normaliza al casing canónico para que el Select lo
  // encuentre; si no existe, se antepone el valor crudo para no perder data.
  const deptoOptions = useMemo(() => {
    const list = [...DEPTOS];
    if (!form.departamento) return list;
    const canonical = list.find(d => d.toLowerCase() === form.departamento.toLowerCase());
    if (!canonical) list.unshift(form.departamento);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.departamento, isEC]);

  useEffect(() => {
    // Solo normalizamos casing en Colombia (dropdown canónico). En EC la ciudad es
    // texto libre y no queremos re-casificar la provincia guardada.
    if (isEC || !form.departamento) return;
    const canonical = DEPARTAMENTOS_NOMBRES.find(
      d => d.toLowerCase() === form.departamento.toLowerCase(),
    );
    if (canonical && canonical !== form.departamento) {
      onChange(f => ({ ...f, departamento: canonical }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.departamento]);

  const ciudades = useMemo(() => (isEC ? [] : getCiudadesDe(form.departamento)), [form.departamento, isEC]);

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
      onChange(f => ({ ...f, ciudad: canonical }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ciudades]);

  return (
    <div className="space-y-6">
      {/* ---- Información del cliente ---- */}
      <section className="space-y-3">
        <header className="flex items-center gap-2 pb-2 border-b border-border">
          <User size={14} className="text-accent" aria-hidden="true" />
          <h3 className="hud-label text-foreground">
            Información del cliente
          </h3>
        </header>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-nombre" className={LABEL_CLS}>Nombre *</Label>
            <Input
              id="edit-nombre"
              value={form.nombre}
              onChange={e => onChange(f => ({ ...f, nombre: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-apellido" className={LABEL_CLS}>Apellido</Label>
            <Input
              id="edit-apellido"
              value={form.apellido}
              onChange={e => onChange(f => ({ ...f, apellido: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-phone" className={LABEL_CLS}>Teléfono (solo dígitos)</Label>
            <Input
              id="edit-phone"
              inputMode="numeric"
              value={form.phone}
              // tabular-nums: el teléfono se dicta dígito a dígito al cliente;
              // con cifras de ancho fijo no se salta ninguna al leerlo.
              className="font-mono tabular-nums"
              onChange={e => onChange(f => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 15) }))}
              placeholder="3001234567"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-email" className={LABEL_CLS}>Email (opcional)</Label>
            <Input
              id="edit-email"
              type="email"
              value={form.email}
              onChange={e => onChange(f => ({ ...f, email: e.target.value }))}
              placeholder="cliente@ejemplo.com"
            />
          </div>
        </div>
      </section>

      {/* ---- Dirección de entrega ---- */}
      <section className="space-y-3">
        <header className="flex items-center gap-2 pb-2 border-b border-border">
          <MapPin size={14} className="text-accent" aria-hidden="true" />
          <h3 className="hud-label text-foreground">
            Dirección de entrega
          </h3>
        </header>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className={LABEL_CLS}>{isEC ? 'Provincia *' : 'Departamento *'}</Label>
            {isEC ? (
              <>
                <Input
                  list="ec-provincias"
                  value={form.departamento}
                  onChange={e => onChange(f => ({ ...f, departamento: e.target.value }))}
                  placeholder="Ej. Guayas"
                />
                <datalist id="ec-provincias">
                  {PROVINCIAS_ECUADOR.map(p => <option key={p} value={p} />)}
                </datalist>
              </>
            ) : (
              <Select
                value={form.departamento || undefined}
                onValueChange={(v) => onChange(f => ({ ...f, departamento: v, ciudad: '' }))}
              >
                <SelectTrigger><SelectValue placeholder="Seleccionar..." /></SelectTrigger>
                <SelectContent>
                  {deptoOptions.map(d => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className={LABEL_CLS}>Ciudad *</Label>
            {isEC ? (
              <Input
                value={form.ciudad}
                onChange={e => onChange(f => ({ ...f, ciudad: e.target.value }))}
                placeholder="Ej. Guayaquil"
              />
            ) : (
              <Select
                value={form.ciudad || undefined}
                onValueChange={(v) => onChange(f => ({ ...f, ciudad: v }))}
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
            )}
          </div>

          <div className="md:col-span-2 space-y-2">
            <Label htmlFor="edit-direccion" className={LABEL_CLS}>Dirección *</Label>
            <AddressAutocomplete
              value={form.direccion}
              ciudad={form.ciudad}
              customerPhone={form.phone}
              onChange={(update) => {
                onChange(prev => ({
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
              onOverrideChange={() => { /* el editor no aplica gate de despacho */ }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
