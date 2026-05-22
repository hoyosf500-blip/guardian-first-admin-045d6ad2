import { useState } from 'react';
import { Search, Loader2, Package } from 'lucide-react';
import { usePushToDropi, type DropiProductHit } from '@/hooks/usePushToDropi';
import { toast } from 'sonner';

interface Props {
  storeId: string | null;
  /** Se llama al elegir un producto (y variación si es VARIABLE). */
  onSelect: (dropiProductId: number, dropiVariationId: number | null, label: string) => void;
  /** true mientras se guarda el vínculo (deshabilita los botones). */
  busy?: boolean;
}

/**
 * Buscador del catálogo de Dropi (estilo Dropify). El operador escribe el nombre
 * del producto, elige el real de la lista y así guardamos el id de Dropi correcto
 * (en vez de pegar un id a ciegas, que fue la causa del error "$type"). Si el
 * producto es VARIABLE, pide elegir la variación.
 */
export default function DropiProductSearch({ storeId, onSelect, busy }: Props) {
  const { searchDropiProducts } = usePushToDropi(storeId);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<DropiProductHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, setPending] = useState<DropiProductHit | null>(null); // VARIABLE esperando variación

  async function run() {
    const query = q.trim();
    if (query.length < 2) { toast.error('Escribí al menos 2 letras'); return; }
    setLoading(true); setSearched(true); setPending(null);
    try {
      setResults(await searchDropiProducts(query));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo buscar en Dropi');
      setResults([]);
    } finally { setLoading(false); }
  }

  function pick(p: DropiProductHit) {
    if (p.type?.toUpperCase() === 'VARIABLE' && (p.variations?.length ?? 0) > 0) setPending(p);
    else onSelect(p.id, null, p.name);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void run(); } }}
          placeholder="Buscá el producto en Dropi por nombre…"
          className="h-8 flex-1 min-w-0 rounded border border-border bg-background px-2 text-sm" />
        <button type="button" onClick={() => void run()} disabled={loading || busy || q.trim().length < 2}
          className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Buscar
        </button>
      </div>

      {pending ? (
        <div className="rounded border border-border bg-background p-2 space-y-1.5">
          <div className="text-[11px] text-muted-foreground">Elegí la variación de <strong className="text-foreground">{pending.name}</strong>:</div>
          <div className="flex flex-wrap gap-1.5">
            {pending.variations!.map(v => (
              <button key={v.id} type="button" disabled={busy}
                onClick={() => onSelect(pending.id, v.id, `${pending.name} · ${v.name}`)}
                className="h-7 px-2 rounded border border-border text-xs hover:border-primary hover:text-primary disabled:opacity-50">
                {v.name}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setPending(null)} className="text-[11px] text-muted-foreground hover:text-foreground">← volver a resultados</button>
        </div>
      ) : results.length > 0 ? (
        <div className="rounded border border-border divide-y divide-border max-h-44 overflow-y-auto">
          {results.map(p => (
            <button key={p.id} type="button" onClick={() => pick(p)} disabled={busy}
              className="w-full text-left px-2 py-1.5 hover:bg-muted/40 flex items-center gap-2 disabled:opacity-50">
              <Package size={13} className="text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0 truncate text-sm text-foreground">{p.name}</span>
              <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{p.id}{p.type?.toUpperCase() === 'VARIABLE' ? ' · var' : ''}</span>
            </button>
          ))}
        </div>
      ) : searched && !loading ? (
        <div className="text-[11px] text-muted-foreground">No se encontró ningún producto con ese nombre en tu Dropi.</div>
      ) : null}
    </div>
  );
}
