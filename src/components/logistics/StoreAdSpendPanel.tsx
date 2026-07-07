import { useState } from 'react';
import { Megaphone, Plus, Pencil, AlertCircle } from 'lucide-react';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { useStore } from '@/contexts/StoreContext';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  useStoreAdSpendRange, sumAdSpend, PLATFORM_LABEL,
  type StoreAdSpendRow,
} from '@/hooks/useStoreAdSpend';
import StoreAdSpendDialog from './StoreAdSpendDialog';

// Panel "Pauta diaria" — vive en Logística → Resumen, debajo de "Cómo voy".
// Totales del período por canal + tabla de últimos días (editable) + botón cargar.
// managerOnly ya lo garantiza Logística; igual gateamos por isManagerOfActive.

interface Props { filters: LogisticsFilters; }

function fmtDay(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

export default function StoreAdSpendPanel({ filters }: Props) {
  const { isManagerOfActive } = useStore();
  const { data, isLoading, isError } = useStoreAdSpendRange(filters.fromDate, filters.toDate);
  const [dialog, setDialog] = useState<{ open: boolean; row: StoreAdSpendRow | null }>({ open: false, row: null });

  if (!isManagerOfActive) return null;

  const rows = data ?? [];
  const totals = sumAdSpend(rows);

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Megaphone size={14} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">Pauta diaria</h3>
        </div>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setDialog({ open: true, row: null })}>
          <Plus size={12} className="mr-1.5" /> Registrar pauta
        </Button>
      </header>

      {isError ? (
        <div className="px-5 py-4 flex items-start gap-2 text-xs text-muted-foreground">
          <AlertCircle size={14} className="text-warning shrink-0 mt-0.5" />
          <span>
            El control de pauta aún no está activo (falta aplicar la migración en la base).
            Cuando se aplique, acá vas a poder registrar tu gasto diario.
          </span>
        </div>
      ) : (
        <>
          {/* Totales del período por canal */}
          <div className="px-5 py-3 border-b border-border flex items-center gap-4 flex-wrap text-xs">
            <span className="text-muted-foreground">Este período:</span>
            <span className="text-foreground"><strong>Meta</strong> {formatCOP(totals.meta)}</span>
            <span className="text-foreground"><strong>TikTok</strong> {formatCOP(totals.tiktok)}</span>
            {totals.other > 0 && (
              <span className="text-foreground"><strong>Otros</strong> {formatCOP(totals.other)}</span>
            )}
            <span className="ml-auto text-accent font-bold">Total {formatCOP(totals.total)}</span>
          </div>

          {/* Tabla de últimos días */}
          {isLoading ? (
            <div className="p-5"><div className="h-16 animate-pulse bg-muted/30 rounded" /></div>
          ) : rows.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-muted-foreground">
              Sin pauta cargada en este período. Tocá <strong>Registrar pauta</strong> para anotar
              lo del día.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-muted-foreground text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-2 text-left font-semibold">Día</th>
                  <th className="px-5 py-2 text-left font-semibold">Canal</th>
                  <th className="px-5 py-2 text-right font-semibold">Monto</th>
                  <th className="px-5 py-2 text-left font-semibold">Nota</th>
                  <th className="px-5 py-2 text-right font-semibold">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/20">
                    <td className="px-5 py-2 text-xs text-foreground">{fmtDay(r.spend_date)}</td>
                    <td className="px-5 py-2 text-xs text-foreground">{PLATFORM_LABEL[r.platform]}</td>
                    <td className="px-5 py-2 text-right text-xs font-mono tabular-nums text-foreground">{formatCOP(r.amount)}</td>
                    <td className="px-5 py-2 text-xs text-muted-foreground truncate max-w-[12rem]">{r.notas ?? ''}</td>
                    <td className="px-5 py-2 text-right">
                      <button
                        onClick={() => setDialog({ open: true, row: r })}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        <Pencil size={11} /> Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <StoreAdSpendDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog({ open, row: open ? dialog.row : null })}
        editing={dialog.row}
      />
    </section>
  );
}
