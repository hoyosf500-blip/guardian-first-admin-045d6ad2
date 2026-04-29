import { memo, useMemo } from 'react';
import { Grid3x3, Info } from 'lucide-react';
import { useCityCarrierMatrix } from '@/hooks/useCityCarrierMatrix';
import type { LogisticsFilters } from '@/lib/logistics.types';

interface Props {
  filters: LogisticsFilters;
  /** Tope de ciudades. Default: 20 (top por volumen). */
  topCities?: number;
  /** Pedidos mínimos por ciudad para ser incluida. Default: 20. */
  minOrders?: number;
}

/**
 * Heatmap transportadora × ciudad. Filas: ciudades (top N por volumen).
 * Columnas: transportadoras. Celdas: % de entrega coloreado.
 *
 * Verde (≥80%) → mejor / Amarillo (60-80%) → ok / Rojo (<60%) → malo /
 * Vacío gris → carrier no opera en esa ciudad.
 */
export default memo(function CarrierCityMatrix({
  filters,
  topCities = 20,
  minOrders = 20,
}: Props) {
  const matrix = useCityCarrierMatrix({ filters, minOrders, topCities });

  const { rows, carriers } = useMemo(() => {
    const data = matrix.data ?? [];
    const carrierSet = new Set<string>();
    const cityMap = new Map<string, {
      ciudad: string;
      departamento: string;
      total: number;
      byCarrier: Record<string, { tasa: number; total: number; entregados: number }>;
    }>();

    for (const r of data) {
      carrierSet.add(r.transportadora);
      const key = r.ciudad;
      const existing = cityMap.get(key);
      if (existing) {
        existing.byCarrier[r.transportadora] = {
          tasa: r.tasa_entrega,
          total: r.total_pedidos,
          entregados: r.entregados,
        };
      } else {
        cityMap.set(key, {
          ciudad: r.ciudad,
          departamento: r.departamento,
          total: r.ciudad_total,
          byCarrier: {
            [r.transportadora]: {
              tasa: r.tasa_entrega,
              total: r.total_pedidos,
              entregados: r.entregados,
            },
          },
        });
      }
    }

    return {
      rows: Array.from(cityMap.values()).sort((a, b) => b.total - a.total),
      carriers: Array.from(carrierSet).sort(),
    };
  }, [matrix.data]);

  if (matrix.isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 skeleton-shimmer min-h-[300px]" />
    );
  }

  if (matrix.isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-danger">
        Error cargando matriz: {matrix.error?.message}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-center">
        <Info size={28} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm font-semibold text-foreground">Sin datos para el heatmap</p>
        <p className="text-xs text-muted-foreground mt-1">
          No hay ciudades con ≥{minOrders} pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Grid3x3 size={14} className="text-info" aria-hidden="true" strokeWidth={2.25} />
          <h2 className="text-sm font-bold text-foreground uppercase tracking-[0.08em]">
            Matriz de desempeño: Transportadora × Ciudad
          </h2>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          % de entrega · Top {rows.length} ciudades por volumen · Solo carriers con ≥5 pedidos por ciudad
        </p>

        <div className="flex items-center gap-3 mt-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-success/30 ring-1 ring-success/40" aria-hidden="true" />
            ≥80%
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-warning/30 ring-1 ring-warning/40" aria-hidden="true" />
            60–80%
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-danger/30 ring-1 ring-danger/40" aria-hidden="true" />
            &lt;60%
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-muted/40 ring-1 ring-border" aria-hidden="true" />
            Sin datos
          </span>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/60 bg-muted/20">
              <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sticky left-0 bg-muted/20 z-10 min-w-[160px]">
                Ciudad
              </th>
              <th className="text-right px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Vol.
              </th>
              {carriers.map(c => (
                <th
                  key={c}
                  className="text-center px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground min-w-[80px]"
                  title={c}
                >
                  <span className="truncate inline-block max-w-[90px]">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.ciudad} className="border-b border-border/40">
                <td className="px-4 py-2 sticky left-0 bg-card z-10">
                  <div className="font-semibold text-foreground truncate max-w-[150px]" title={row.ciudad}>
                    {row.ciudad}
                  </div>
                  {row.departamento && (
                    <div className="text-[10px] text-muted-foreground truncate max-w-[150px]">
                      {row.departamento}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {row.total.toLocaleString('es-CO')}
                </td>
                {carriers.map(c => {
                  const cell = row.byCarrier[c];
                  if (!cell) {
                    return (
                      <td key={c} className="px-3 py-2 text-center">
                        <span className="text-muted-foreground/50 text-[11px]">—</span>
                      </td>
                    );
                  }
                  const { bg, ring, text } = cellStyle(cell.tasa);
                  return (
                    <td
                      key={c}
                      className={`px-2 py-2 text-center ${bg} ${ring} ring-1`}
                      title={`${c} en ${row.ciudad}: ${cell.entregados}/${cell.total} entregados (${cell.tasa.toFixed(1)}%)`}
                    >
                      <div className={`font-mono font-bold tabular-nums text-xs ${text}`}>
                        {cell.tasa.toFixed(0)}%
                      </div>
                      <div className="text-[9px] text-muted-foreground tabular-nums">
                        {cell.total}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

function cellStyle(tasa: number): { bg: string; ring: string; text: string } {
  if (tasa >= 80) {
    return { bg: 'bg-success/15', ring: 'ring-success/30', text: 'text-success' };
  }
  if (tasa >= 60) {
    return { bg: 'bg-warning/15', ring: 'ring-warning/30', text: 'text-warning' };
  }
  return { bg: 'bg-danger/15', ring: 'ring-danger/30', text: 'text-danger' };
}
