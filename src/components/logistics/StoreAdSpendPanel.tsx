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
    <section className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong">
      <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Megaphone size={14} className="text-accent" aria-hidden="true" />
          Pauta diaria
        </h3>
        <Button size="sm" variant="outline" className="h-9 rounded-xl" onClick={() => setDialog({ open: true, row: null })}>
          <Plus size={13} className="mr-1.5" aria-hidden="true" /> Registrar pauta
        </Button>
      </header>

      {isError ? (
        // "La feature todavía no existe" NO es un error genérico: banner ámbar,
        // no rojo, con el mismo molde de barra lateral + chip del resto.
        <div className="m-4 relative flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d">
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-warning/20 glow-warning">
            <AlertCircle size={17} className="text-warning" aria-hidden="true" />
          </div>
          <span className="text-[11px] text-muted-foreground leading-relaxed flex-1 min-w-0">
            El control de pauta aún no está activo (falta aplicar la migración en la base).
            Cuando se aplique, acá vas a poder registrar tu gasto diario.
          </span>
        </div>
      ) : (
        <>
          {/* Totales del período por canal — cada canal como celda con su
              rótulo en .hud-label sobre la cifra en mono, en vez de spans
              sueltos en una línea. El Total va con el tono de acento. */}
          <div className="px-5 py-4 border-b border-border">
            <div className="hud-label mb-2.5">Este período:</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl border border-border bg-card/40 px-3 py-2.5">
                <div className="hud-label-cased">Meta</div>
                <div className="text-sm font-mono tabular-nums font-bold text-foreground mt-1.5">{formatCOP(totals.meta)}</div>
              </div>
              <div className="rounded-xl border border-border bg-card/40 px-3 py-2.5">
                <div className="hud-label-cased">TikTok</div>
                <div className="text-sm font-mono tabular-nums font-bold text-foreground mt-1.5">{formatCOP(totals.tiktok)}</div>
              </div>
              {totals.other > 0 && (
                <div className="rounded-xl border border-border bg-card/40 px-3 py-2.5">
                  <div className="hud-label">Otros</div>
                  <div className="text-sm font-mono tabular-nums font-bold text-foreground mt-1.5">{formatCOP(totals.other)}</div>
                </div>
              )}
              <div className="rounded-xl border border-accent/30 bg-accent/10 px-3 py-2.5 sm:ml-auto sm:w-full">
                <div className="hud-label text-accent">Total</div>
                <div className="text-sm font-mono tabular-nums font-bold text-accent mt-1.5">{formatCOP(totals.total)}</div>
              </div>
            </div>
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
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-2.5 text-left hud-label font-normal">Día</th>
                  <th className="px-3 py-2.5 text-left hud-label font-normal">Canal</th>
                  <th className="px-3 py-2.5 text-right hud-label font-normal">Monto</th>
                  <th className="px-3 py-2.5 text-left hud-label font-normal">Nota</th>
                  <th className="px-5 py-2.5 text-right hud-label font-normal">Acción</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-card/60 transition-colors duration-200">
                    <td className="px-5 py-2.5 font-mono tabular-nums text-foreground whitespace-nowrap">{fmtDay(r.spend_date)}</td>
                    <td className="px-3 py-2.5 text-foreground">{PLATFORM_LABEL[r.platform]}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">{formatCOP(r.amount)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[12rem]">{r.notas ?? ''}</td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        onClick={() => setDialog({ open: true, row: r })}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-transparent text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                      >
                        <Pencil size={11} aria-hidden="true" /> Editar
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
