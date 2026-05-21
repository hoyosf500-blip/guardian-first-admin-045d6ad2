import { useState } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { ChevronsUpDown, Check, Plus, Store as StoreIcon, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Selector de tienda activa para el sidebar. Solo lista tiendas donde el
 * usuario es miembro (RLS lo garantiza). Cambiar la tienda recarga la
 * página: muchos hooks tienen cache local y la forma simple de evitar
 * estado stale entre tiendas es un hard refresh.
 */
export default function StoreSelector() {
  const { stores, activeStore, setActiveStoreId, refresh } = useStore();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  if (!activeStore) return null;

  function pick(id: string) {
    if (id === activeStore?.id) { setOpen(false); return; }
    setActiveStoreId(id);
    setOpen(false);
    // Recarga para que todos los caches/queries se reseteen al store_id nuevo.
    if (typeof window !== 'undefined') window.location.reload();
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card hover:bg-card/70 transition-colors text-left"
            aria-label="Cambiar tienda"
          >
            <StoreIcon size={14} className="text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-foreground truncate">{activeStore.name}</div>
              <div className="text-[10px] text-muted-foreground">
                {activeStore.country_code} · {activeStore.role === 'owner' ? 'Dueño' : 'Operador'}
              </div>
            </div>
            <ChevronsUpDown size={12} className="text-muted-foreground flex-shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-1" align="start">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Tus tiendas
          </div>
          {stores.map(s => (
            <button
              key={s.id}
              onClick={() => pick(s.id)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-accent/10 transition-colors"
            >
              <Check size={12} className={s.id === activeStore.id ? 'text-accent' : 'text-transparent'} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{s.name}</div>
                <div className="text-[10px] text-muted-foreground">{s.country_code} · {s.role}</div>
              </div>
            </button>
          ))}
          <div className="border-t border-border my-1" />
          <button
            onClick={() => { setOpen(false); setCreateOpen(true); }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-accent/10 transition-colors"
          >
            <Plus size={12} className="text-accent" />
            <span className="text-xs font-semibold text-foreground">Crear tienda nueva</span>
          </button>
        </PopoverContent>
      </Popover>

      <CreateStoreDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={async () => {
        await refresh();
      }} />
    </>
  );
}

function CreateStoreDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => Promise<void> }) {
  const { setActiveStoreId } = useStore();
  const [name, setName] = useState('');
  const [country, setCountry] = useState('CO');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (name.trim().length < 2) { toast.error('Nombre muy corto'); return; }
    if (country.length !== 2) { toast.error('Country code debe ser 2 letras'); return; }
    setSaving(true);
    const { data, error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: string | null; error: { message: string } | null }>)(
      'create_store',
      { p_name: name.trim(), p_country_code: country.toUpperCase() },
    );
    if (error || !data) {
      toast.error('No se pudo crear', { description: error?.message });
      setSaving(false); return;
    }
    toast.success(`Tienda "${name}" creada`);
    setActiveStoreId(data);
    await onCreated();
    setSaving(false);
    onOpenChange(false);
    setName(''); setCountry('CO');
    if (typeof window !== 'undefined') window.location.reload();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Crear nueva tienda</DialogTitle>
          <DialogDescription>
            Quedás como dueño. Después cargá las credenciales Dropi desde /admin.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="store-name">Nombre</Label>
            <Input id="store-name" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="store-country">País (2 letras)</Label>
            <Input id="store-country" maxLength={2} value={country}
              onChange={e => setCountry(e.target.value.toUpperCase())}
              placeholder="CO, EC, MX..." />
          </div>
          <DialogFooter>
            <button type="submit" disabled={saving}
              className="inline-flex items-center gap-2 px-4 h-9 rounded-lg bg-accent text-accent-foreground text-sm font-semibold disabled:opacity-50">
              {saving && <Loader2 size={13} className="animate-spin" />}
              Crear tienda
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
