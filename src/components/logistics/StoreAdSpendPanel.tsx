import { useState } from 'react';
import { Megaphone, Plus, Pencil, AlertCircle, RefreshCw } from 'lucide-react';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { useStore } from '@/contexts/StoreContext';
import { formatCOP } from '@/lib/utils';
import { isRpcMissing } from '@/lib/rpcError';
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
  // Con día de semana: "vie 05 ago" — ubica el registro sin abrir el calendario.
  return new Date(y, m - 1, day).toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short' });
}

export default function StoreAdSpendPanel({ filters }: Props) {
  const { isManagerOfActive } = useStore();
  const { data, isLoading, isError, error, refetch } = useStoreAdSpendRange(filters.fromDate, filters.toDate);
  const [dialog, setDialog] = useState<{ open: boolean; row: StoreAdSpendRow | null }>({ open: false, row: null });

  if (!isManagerOfActive) return null;

  const rows = data ?? [];
  const totals = sumAdSpend(rows);

  // Cobertura: días transcurridos del período vs días con algo anotado. Un día
  // sin registro entra como $0 al Neto Real y a los KPIs de pauta — si faltan
  // días, se dice acá, que es donde se corrige (medido 23-ago-2026 EC: 1 de 23).
  const hoy = new Date().toLocaleDateString('en-CA');
  const hasta = filters.toDate < hoy ? filters.toDate : hoy;
  const diasPeriodo = (() => {
    const f = new Date(`${filters.fromDate}T12:00:00Z`);
    const t = new Date(`${hasta}T12:00:00Z`);
    if (isNaN(f.getTime()) || isNaN(t.getTime()) || t < f) return 0;
    return Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  })();
  const diasConPauta = new Set(rows.map((r) => r.spend_date)).size;
  const coberturaIncompleta = diasPeriodo > 0 && diasConPauta < diasPeriodo;

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
        // Dos errores DISTINTOS que antes compartían un solo rótulo: un 500/red
        // transitorio le decía al dueño —que lleva semanas cargando pauta— que
        // "falta aplicar la migración" (auditoría 24-ago-2026). Solo isRpcMissing
        // es "la feature no existe"; el resto es transitorio y se reintenta.
        isRpcMissing(error) ? (
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
          <div className="m-4 relative flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
            <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-danger/20 glow-danger">
              <AlertCircle size={17} className="text-danger" aria-hidden="true" />
            </div>
            <span className="text-[11px] text-muted-foreground leading-relaxed flex-1 min-w-0">
              No se pudo leer tu pauta (error temporal). Tus registros están guardados.
              <Button size="sm" variant="outline" className="h-7 rounded-lg ml-2" onClick={() => refetch()}>
                <RefreshCw size={11} className="mr-1" aria-hidden="true" /> Reintentar
              </Button>
            </span>
          </div>
        )
      ) : isLoading ? (
        // Los totales y el chip de cobertura NO se dibujan hasta tener datos:
        // "Meta $0 · 0 de 23 días" mientras carga era un cero afirmado sobre
        // datos que no llegaron (regla: cero ≠ "no se pudo medir").
        <div className="p-5 space-y-3">
          <div className="h-20 animate-pulse bg-muted/30 rounded-2xl" />
          <div className="h-16 animate-pulse bg-muted/30 rounded-2xl" />
        </div>
      ) : (
        <>
          {/* Totales del período por canal — cada canal como celda con su
              rótulo en .hud-label sobre la cifra en mono, en vez de spans
              sueltos en una línea. El Total va con el tono de acento. */}
          <div className="px-5 py-4 border-b border-border">
            <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
              <div className="hud-label">Este período:</div>
              {/* Cobertura SIEMPRE visible: verde si está completa, ámbar si no.
                  Es el dato que explica por qué el Neto Real puede estar inflado. */}
              {diasPeriodo > 0 && (
                <span className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-[11px] font-semibold font-mono tabular-nums ${
                  coberturaIncompleta
                    ? 'border-warning/30 bg-warning/10 text-warning'
                    : 'border-success/30 bg-success/10 text-success'
                }`}>
                  {diasConPauta} de {diasPeriodo} días con pauta anotada
                </span>
              )}
            </div>
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
            {coberturaIncompleta && (
              <p className="mt-2.5 text-[11px] text-warning leading-relaxed">
                Los días sin registro cuentan como $0 en el Neto Real — anotá
                aunque sea el total del día para que la ganancia no salga inflada.
              </p>
            )}
          </div>

          {/* Tabla de últimos días */}
          {rows.length === 0 ? (
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
              <tfoot>
                <tr className="border-t border-border font-semibold text-foreground">
                  <td className="px-5 py-2.5" colSpan={2}>Total del período</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">{formatCOP(totals.total)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          )}
        </>
      )}

      <StoreAdSpendDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog({ open, row: open ? dialog.row : null })}
        editing={dialog.row}
        visibleFrom={filters.fromDate}
        visibleTo={filters.toDate}
      />
    </section>
  );
}
