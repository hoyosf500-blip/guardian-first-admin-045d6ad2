import { Package } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { describirVariante } from '@/lib/varianteChips';
import type { OrderLineDetail } from '@/lib/orderUtils';

/**
 * El recuadro "Producto" de la ficha que la asesora tiene abierta MIENTRAS
 * habla con el cliente.
 *
 * Vive en un solo archivo a propósito: antes este bloque estaba copiado en
 * CallView (Confirmar) y CrmCallView (Seguimiento), se tocó una copia y no la
 * otra, y las tallas salían en una pantalla sí y en la otra no (2026-07-21).
 * Si hay que cambiar cómo se ve el producto, se cambia acá y las dos fichas
 * quedan iguales.
 *
 * Con variantes (zapatos: talla + color) se lista UNA LÍNEA POR PAR, porque
 * antes salía el nombre repetido —"Sneakers, Sneakers"— y la asesora no podía
 * decirle al cliente qué tallas venían. Sin variantes, o en pedidos que
 * todavía no re-sincronizaron desde Dropi, cae al texto de siempre.
 */
export function ProductoTile({
  producto,
  lineas,
  /** Sólo para el texto de respaldo ("Producto × 2") cuando no hay detalle. */
  cantidad,
}: {
  producto?: string;
  lineas?: OrderLineDetail[];
  cantidad?: number;
}) {
  const items = lineas ?? [];
  const tieneDetalle = items.length > 0;

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-2xl bg-card/40 border border-border hover:border-border-strong transition-colors duration-200 ${
        // Con talla y color el renglón necesita el ancho completo: en media
        // columna el nombre del zapato se parte en tres y queda ilegible.
        tieneDetalle ? 'sm:col-span-2' : ''
      }`}
    >
      <span
        className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0"
        aria-hidden="true"
      >
        <Package size={16} />
      </span>

      {tieneDetalle ? (
        <ul className="min-w-0 flex-1 flex flex-col gap-2.5">
          {items.map((l, i) => {
            const chips = describirVariante(l.variante);
            return (
              <li
                key={i}
                className={`flex flex-col gap-2 min-w-0 ${
                  i > 0 ? 'pt-2.5 border-t border-border/60' : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-3 min-w-0">
                  <span className="text-sm font-semibold text-foreground min-w-0 break-words">
                    {l.nombre}
                  </span>
                  {l.precio > 0 && (
                    <span className="font-mono tabular-nums text-sm font-semibold text-foreground whitespace-nowrap">
                      {formatCOP(l.precio)}
                    </span>
                  )}
                </div>

                {(chips.length > 0 || l.cantidad > 1) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {chips.map((c, j) => (
                      <span
                        key={j}
                        className="inline-flex items-baseline gap-1.5 rounded-xl border border-accent/30 bg-accent/14 px-2.5 py-1"
                      >
                        {c.etiqueta && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-accent/70">
                            {c.etiqueta}
                          </span>
                        )}
                        <span className="text-[13px] font-bold text-accent">{c.valor}</span>
                      </span>
                    ))}
                    {l.cantidad > 1 && (
                      <span className="inline-flex items-baseline gap-1.5 rounded-xl border border-border bg-card/60 px-2.5 py-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Cantidad
                        </span>
                        <span className="font-mono tabular-nums text-[13px] font-bold text-foreground">
                          {l.cantidad}
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="text-sm font-medium text-foreground min-w-0 break-words self-center">
          {producto || '—'}
          {(cantidad ?? 0) > 1 ? ` × ${cantidad}` : ''}
        </span>
      )}
    </div>
  );
}

export default ProductoTile;
