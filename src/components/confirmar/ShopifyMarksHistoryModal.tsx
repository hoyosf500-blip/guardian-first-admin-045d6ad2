import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X, RotateCcw, AlertTriangle, CheckCircle2, Loader2, History } from 'lucide-react';
import { toast } from 'sonner';
import { useShopifyManualMarks } from '@/hooks/useShopifyManualMarks';
import {
  defaultMarkRange, filterMarksByRange, groupMarksByDay, markReconStatus,
  type DateRange, type ManualMark,
} from '@/lib/shopifyMarks';

interface Props {
  storeId: string;
  /** Ids de pedidos AÚN pendientes (no están en Dropi) — para marcar las fugas. */
  pendingIds: Set<string>;
  onClose: () => void;
  /** El panel quita el pedido del `done` local y refetchea → vuelve a la cola. */
  onReverted: (shopifyOrderId: string) => void;
}

const BOGOTA = 'America/Bogota';
const timeFmt = new Intl.DateTimeFormat('es-CO', { timeZone: BOGOTA, hour: '2-digit', minute: '2-digit' });

function dayLabel(date: string, today: string): string {
  if (date === today) return 'Hoy';
  const t = new Date(today + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() - 1);
  if (date === t.toISOString().slice(0, 10)) return 'Ayer';
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
}

/**
 * Historial de marcas "Ya lo metí". Default = últimos 3 días (filtrable). Muestra
 * SIEMPRE el total histórico para distinguir viejas de nuevas, y marca en rojo las
 * que se marcaron pero NO están en Dropi (la fuga del doble-click). Permite revertir.
 */
export default function ShopifyMarksHistoryModal({ storeId, pendingIds, onClose, onReverted }: Props) {
  const { marks, totalCount, isLoading, revertMark } = useShopifyManualMarks(storeId);
  const [range, setRange] = useState<DateRange>(() => defaultMarkRange(Date.now(), 3));
  const [reverting, setReverting] = useState<string | null>(null);

  const today = useMemo(() => range.to, [range.to]);
  const visible = useMemo(() => filterMarksByRange(marks, range), [marks, range]);
  const groups = useMemo(() => groupMarksByDay(visible), [visible]);
  const missingCount = useMemo(
    () => visible.filter(m => markReconStatus(m.shopify_order_id, pendingIds) === 'missing').length,
    [visible, pendingIds],
  );

  const resetRange = useCallback(() => setRange(defaultMarkRange(Date.now(), 3)), []);

  const doRevert = useCallback(async (mark: ManualMark) => {
    setReverting(mark.id);
    const r = await revertMark(mark.id);
    setReverting(null);
    if (!r.ok) { toast.error('No se pudo revertir: ' + (r.error || '')); return; }
    toast.success(`"${mark.shopify_name || mark.customer || 'pedido'}" volvió a la cola de pendientes`);
    onReverted(mark.shopify_order_id);
  }, [revertMark, onReverted]);

  const dateInput = 'h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30';

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border border-border bg-card shadow-xl">

        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center gap-2 flex-shrink-0">
          <History size={16} className="text-primary" />
          <h3 className="text-sm font-semibold text-foreground flex-1">Historial · "Ya lo metí"</h3>
          <button onClick={onClose} className="h-7 w-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>

        {/* Filtro de fechas + totales */}
        <div className="px-5 py-3 border-b border-border flex flex-col gap-2 flex-shrink-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Desde</span>
            <input type="date" value={range.from} max={range.to}
              onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className={dateInput} />
            <span className="text-muted-foreground">hasta</span>
            <input type="date" value={range.to} min={range.from}
              onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className={dateInput} />
            <button onClick={resetRange} className="h-8 px-2.5 rounded-lg border border-border bg-card text-xs text-muted-foreground hover:text-foreground">Últimos 3 días</button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-foreground">
              <span className="font-semibold tabular-nums">{visible.length}</span> en el rango
            </span>
            <span className="opacity-50">|</span>
            <span className="text-muted-foreground">
              Total histórico: <span className="font-semibold tabular-nums text-foreground">{totalCount}</span>
            </span>
            {missingCount > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 font-semibold text-destructive">
                <AlertTriangle size={11} /> {missingCount} sin llegar a Dropi
              </span>
            )}
          </div>
        </div>

        {/* Lista */}
        <div className="overflow-y-auto flex-1 min-h-[8rem]">
          {isLoading ? (
            <div className="p-8 flex items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" size={20} /></div>
          ) : visible.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No hay marcas en este rango.
              {totalCount > 0 && <span className="block mt-1 text-xs">Hay {totalCount} en total — ampliá el rango de fechas.</span>}
            </div>
          ) : (
            groups.map(([date, items]) => (
              <div key={date}>
                <div className="sticky top-0 z-10 px-5 py-1.5 bg-card/95 backdrop-blur border-b border-border flex items-center gap-2 text-xs">
                  <span className="font-semibold text-foreground">{dayLabel(date, today)}</span>
                  <span className="text-muted-foreground">· {items.length}</span>
                </div>
                <div className="divide-y divide-border">
                  {items.map(m => {
                    const status = markReconStatus(m.shopify_order_id, pendingIds);
                    const missing = status === 'missing';
                    return (
                      <div key={m.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        <span className="text-[10px] font-mono text-muted-foreground w-10 flex-shrink-0">{timeFmt.format(new Date(m.marked_at))}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground truncate">{m.customer || '—'}</span>
                            {m.shopify_name && <span className="text-[10px] font-mono text-muted-foreground">{m.shopify_name}</span>}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground mt-0.5">
                            {m.phone && <span className="font-mono">{m.phone}</span>}
                            {m.city && <span>· {m.city}</span>}
                            {m.total ? <span>· ${m.total.toLocaleString()}</span> : null}
                          </div>
                        </div>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium flex-shrink-0 ${missing ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'}`}>
                          {missing ? <><AlertTriangle size={10} /> no está en Dropi</> : <><CheckCircle2 size={10} /> en Dropi</>}
                        </span>
                        <button onClick={() => doRevert(m)} disabled={reverting === m.id}
                          title="Revertir: el pedido vuelve a la cola de pendientes"
                          className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1 flex-shrink-0 disabled:opacity-50">
                          {reverting === m.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />} Revertir
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-border flex-shrink-0">
          <p className="text-[11px] text-muted-foreground leading-snug">
            <span className="text-destructive font-medium">Rojo = se marcó pero no llegó a Dropi.</span>{' '}
            Verificá ese pedido y, si no lo metiste, tocá «Revertir» para que vuelva a la cola.
          </p>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
