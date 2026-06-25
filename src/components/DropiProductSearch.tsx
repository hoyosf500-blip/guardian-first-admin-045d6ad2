import { useState } from 'react';
import { Search, Loader2, Package, Link2 } from 'lucide-react';
import { usePushToDropi, type DropiProductHit } from '@/hooks/usePushToDropi';
import { toast } from 'sonner';

interface Props {
  storeId: string | null;
  /** Se llama al elegir un producto (y variación si es VARIABLE) o al pegar un id directo.
   *  `hit` es el producto completo de Dropi (nombre, foto, descripción) cuando se eligió
   *  de la búsqueda; es undefined si se pegó un id a ciegas. */
  onSelect: (dropiProductId: number, dropiVariationId: number | null, label: string, hit?: DropiProductHit) => void;
  /** true mientras se guarda el vínculo (deshabilita los botones). */
  busy?: boolean;
}

/**
 * Buscador del catálogo de Dropi (estilo Dropify). El operador escribe el nombre
 * del producto, elige el real de la lista y así guardamos el id de Dropi correcto.
 * Si el producto es VARIABLE, pide elegir la variación.
 *
 * Atajo: si en vez de un nombre pegan un id numérico (ej. 115864), lo vinculamos
 * DIRECTO sin pegarle a Dropi. La búsqueda de Dropi es por NOMBRE — un id nunca
 * matchea (por eso antes daba "no se encontró") — y además así esquivamos el
 * rate-limit (429 "Too Many Attempts") cuando solo se quiere corregir un id.
 */
export default function DropiProductSearch({ storeId, onSelect, busy }: Props) {
  const { searchDropiProducts, getDropiProduct } = usePushToDropi(storeId);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false); // trayendo un producto por id pegado
  const [results, setResults] = useState<DropiProductHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, setPending] = useState<DropiProductHit | null>(null); // VARIABLE esperando variación

  const trimmed = q.trim();
  // Id de Dropi pegado directo (numérico, 3+ dígitos para no confundir con "ok").
  const asId = /^\d{3,}$/.test(trimmed) ? Number(trimmed) : null;

  async function run() {
    if (trimmed.length < 2) { toast.error('Escribí al menos 2 letras'); return; }
    setLoading(true); setSearched(true); setPending(null);
    try {
      setResults(await searchDropiProducts(trimmed));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo buscar en Dropi';
      const friendly = /too many|429|throttl|limit|límit/i.test(msg)
        ? 'Dropi está limitando las búsquedas. Esperá ~1 min, o pegá el ID de Dropi directo.'
        : msg;
      toast.error(friendly);
      setResults([]);
    } finally { setLoading(false); }
  }

  // Pegaron un ID: traemos el producto real de Dropi (nombre + foto + descripción)
  // y autocompletamos. Si Dropi no lo devuelve, lo vinculamos igual "a ciegas"
  // para no bloquear al dueño (nunca se queda colgado).
  async function linkDirect() {
    if (asId == null || linking) return;
    setLinking(true);
    try {
      const hit = await getDropiProduct(asId);
      if (hit) {
        if (hit.type?.toUpperCase() === 'VARIABLE' && (hit.variations?.length ?? 0) > 0) {
          setPending(hit); // pedimos la variación, igual que en la búsqueda por nombre
          toast.success(`Encontrado: ${hit.name}. Elegí la variación.`);
        } else {
          onSelect(hit.id, null, hit.name, hit);
          toast.success(`Traído de Dropi: ${hit.name}`);
        }
      } else {
        onSelect(asId, null, `Dropi #${asId}`);
        toast.warning(`Vinculé el ID #${asId}, pero Dropi no devolvió los datos. Completá nombre y descripción a mano.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      const friendly = /too many|429|throttl|limit|límit/i.test(msg)
        ? 'Dropi está limitando las consultas. Esperá ~1 min e intentá de nuevo.'
        : (msg || `No se pudo traer el producto #${asId} de Dropi.`);
      onSelect(asId, null, `Dropi #${asId}`);
      toast.warning(`Vinculé el ID #${asId} sin datos. ${friendly} Completá nombre y descripción a mano.`);
    } finally {
      setLinking(false);
    }
  }

  function pick(p: DropiProductHit) {
    if (p.type?.toUpperCase() === 'VARIABLE' && (p.variations?.length ?? 0) > 0) setPending(p);
    else onSelect(p.id, null, p.name, p);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (asId != null) void linkDirect(); else void run(); } }}
          placeholder="Nombre del producto, o pegá el ID de Dropi…"
          className="h-8 flex-1 min-w-0 rounded border border-border bg-background px-2 text-sm" />
        {asId != null ? (
          <button type="button" onClick={() => void linkDirect()} disabled={busy || linking}
            className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
            {linking ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Traer #{asId}
          </button>
        ) : (
          <button type="button" onClick={() => void run()} disabled={loading || busy || trimmed.length < 2}
            className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Buscar
          </button>
        )}
      </div>

      {asId != null && (
        <div className="text-[11px] text-muted-foreground">
          {linking
            ? <>Trayendo el producto <strong className="text-foreground">#{asId}</strong> desde Dropi…</>
            : <>Vas a traer el producto <strong className="text-foreground">#{asId}</strong> desde Dropi (nombre, foto y descripción). Si no aparece, lo vinculo igual por ID para que completes a mano.</>}
        </div>
      )}

      {pending ? (
        <div className="rounded border border-border bg-background p-2 space-y-1.5">
          <div className="text-[11px] text-muted-foreground">Elegí la variación de <strong className="text-foreground">{pending.name}</strong>:</div>
          <div className="flex flex-wrap gap-1.5">
            {pending.variations!.map(v => (
              <button key={v.id} type="button" disabled={busy}
                onClick={() => onSelect(pending.id, v.id, `${pending.name} · ${v.name}`, pending)}
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
      ) : searched && !loading && asId == null ? (
        <div className="text-[11px] text-muted-foreground">No se encontró ningún producto con ese nombre en tu Dropi.</div>
      ) : null}
    </div>
  );
}
