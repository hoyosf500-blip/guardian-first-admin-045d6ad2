import { Link } from 'react-router-dom';
import { Loader2, Database, ArrowUpRight } from 'lucide-react';
import { useOrderSearch, MIN_SEARCH_LEN } from '@/hooks/useOrderSearch';

/**
 * Resultados de la búsqueda que corre EN LA BASE, no en el navegador.
 *
 * La lista de abajo solo puede mostrar lo que se descargó (la ventana de días).
 * Este panel dice explícitamente cuántos pedidos hay en TODO el histórico de la
 * tienda para ese término, y de ahí se salta al detalle. Así la asesora deja de
 * concluir "ese cliente no existe" cuando lo único que pasó es que su pedido
 * está fuera de la ventana cargada.
 */
export default function GlobalOrderSearchPanel({
  storeId,
  query,
}: {
  storeId: string | null | undefined;
  query: string;
}) {
  const { hits, loading, error, enabled } = useOrderSearch(storeId, query);

  if (!query.trim()) return null;
  if (!enabled) {
    return (
      <p className="text-[11px] text-muted-foreground px-1">
        Escribí al menos {MIN_SEARCH_LEN} caracteres para buscar en todo el histórico.
      </p>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 px-4 py-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Database size={13} className="text-accent flex-shrink-0" aria-hidden="true" />
        <span className="font-semibold text-foreground">Histórico completo</span>
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" /> buscando…
          </span>
        ) : error ? (
          <span className="text-danger">No se pudo buscar en la base: {error}</span>
        ) : (
          <span className="text-muted-foreground">
            {hits.length === 0
              ? 'sin coincidencias en la base'
              : `${hits.length}${hits.length === 50 ? '+' : ''} pedido${hits.length === 1 ? '' : 's'} (incluye los que están fuera de la ventana de fechas)`}
          </span>
        )}
      </div>

      {!loading && !error && hits.length > 0 && (
        <ul className="divide-y divide-border/60 max-h-64 overflow-y-auto">
          {hits.map((h) => (
            <li key={h.external_id ?? `${h.phone}-${h.fecha}`}>
              <Link
                to={`/pedido/${encodeURIComponent(h.external_id ?? '')}`}
                className="flex items-center gap-3 py-2 text-xs hover:bg-muted/40 rounded-lg px-2 -mx-2 transition-colors"
              >
                <span className="font-mono tabular-nums text-muted-foreground w-20 flex-shrink-0">
                  {h.external_id ?? '—'}
                </span>
                <span className="font-medium text-foreground truncate flex-1 min-w-0">
                  {h.nombre || 'Sin nombre'}
                  <span className="text-muted-foreground font-normal"> · {h.ciudad || 's/ciudad'}</span>
                </span>
                <span className="text-muted-foreground hidden sm:inline flex-shrink-0">{h.fecha || ''}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">
                  {h.estado || '—'}
                </span>
                <ArrowUpRight size={12} className="text-muted-foreground flex-shrink-0" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
