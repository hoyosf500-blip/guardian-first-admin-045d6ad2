import { useCallback, useEffect, useState } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { supabase } from '@/integrations/supabase/client';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { toast } from 'sonner';
import { CloudOff, ChevronDown, ChevronUp, RefreshCw, Loader2, Bot } from 'lucide-react';

// Gestiones (conf/canc) que quedaron en el CRM pero NUNCA llegaron a Dropi
// (order_results.dropi_sync_status='failed'). Antes eran invisibles: el toast
// mentía ("Aparecerá en Novedades") y nadie volvía a mirarlas. Este panel las
// hace visibles arriba de la cola de Confirmar, con reintento manual.
//
// Los pedidos del bot de Dropi (LucidBot/FINAL_ORDER) NO tienen superficie de
// escritura por API — reintentar es inútil eterno. Se marcan con el prefijo
// BOT-SIN-API: en result_notes y acá se muestran como badge informativo.

const BOT_PREFIX = 'BOT-SIN-API:';
const WINDOW_DAYS = 7;
const POLL_MS = 5 * 60_000; // poll suave — nada agresivo, la DB ya va justa

interface FailedGestion {
  id: string;
  orderId: string;
  result: string; // 'conf' | 'canc'
  notes: string;
  createdAt: string;
  externalId: string;
  nombre: string;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/** Motivo corto legible: si la nota trae el patrón del cliente
 *  ("… - reintentar (<causa>)"), muestra solo la causa; si no, trunca. */
function shortReason(notes: string): string {
  const m = notes.match(/reintentar \((.+)\)\s*$/i);
  const txt = (m ? m[1] : notes).trim();
  return txt.length > 90 ? txt.slice(0, 87) + '…' : txt;
}

export default function DropiSyncFailuresPanel() {
  const { activeStoreId } = useStore();
  const [rows, setRows] = useState<FailedGestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeStoreId) return;
    setRefreshing(true);
    try {
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
      // 'failed' + 'pending' ATASCADO: el cliente inserta 'pending' y lo
      // promueve a 'synced'/'failed' al resolver el push; si la pestaña muere
      // en el medio queda 'pending' eterno — sin esto era invisible acá.
      // Misma gracia de 15 min que el retry de dropi-cron (retryStatusFilter);
      // el timestamp va entre comillas por los ":" (parser de or=()).
      const stalePendingIso = new Date(Date.now() - 15 * 60_000).toISOString();
      const { data, error } = await supabase
        .from('order_results')
        .select('id, order_id, result, result_notes, created_at')
        .eq('store_id', activeStoreId)
        .or(`dropi_sync_status.eq.failed,and(dropi_sync_status.eq.pending,created_at.lt."${stalePendingIso}")`)
        .in('result', ['conf', 'canc'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      // Una fila por pedido (la más reciente) — reintentos previos no duplican.
      const byOrder = new Map<string, NonNullable<typeof data>[number]>();
      for (const r of data ?? []) {
        if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
      }

      // Join liviano: resolver external_id/nombre con una 2ª query por id IN.
      const meta = new Map<string, { externalId: string; nombre: string }>();
      const orderIds = [...byOrder.keys()];
      if (orderIds.length > 0) {
        const { data: ords } = await supabase
          .from('orders')
          .select('id, external_id, nombre')
          .in('id', orderIds);
        for (const o of ords ?? []) {
          meta.set(o.id, { externalId: String(o.external_id ?? ''), nombre: o.nombre ?? '' });
        }
      }

      setRows([...byOrder.values()].map(r => ({
        id: r.id,
        orderId: r.order_id,
        result: r.result,
        notes: r.result_notes ?? '',
        createdAt: r.created_at,
        externalId: meta.get(r.order_id)?.externalId ?? '',
        nombre: meta.get(r.order_id)?.nombre ?? '',
      })));
    } catch {
      // Red/RLS caída: no estorbamos la cola — el panel mantiene lo último que vio.
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  }, [activeStoreId]);

  useEffect(() => {
    setRows([]);
    setLoaded(false);
    setExpanded(false);
    if (!activeStoreId) return;
    void load();
    // Poll suave con la pestaña visible (patrón pollWhenVisible existente).
    return pollWhenVisible(() => { void load(); }, POLL_MS, { runOnVisible: false });
  }, [activeStoreId, load]);

  const retry = useCallback(async (row: FailedGestion) => {
    if (busyId || !row.externalId) return;
    setBusyId(row.id);
    try {
      if (row.result === 'conf') {
        const res = await supabase.functions.invoke('dropi-update-order', {
          body: { externalId: row.externalId },
        });
        const data = res?.data as { ok?: boolean; error?: string; code?: string } | null | undefined;
        // Mismo criterio ESTRICTO que OrderContext: éxito solo con ok:true.
        if (res?.error || data?.ok !== true) {
          // code 'pedido_bot' = confirmado sin superficie API por-id: taguear
          // la fila con el prefijo BOT-SIN-API: (mismo string que dropi-cron)
          // para que salga del retry del cron y acá pase a badge informativo.
          if (data?.code === 'pedido_bot' && !row.notes.startsWith(BOT_PREFIX)) {
            await supabase.from('order_results').update({
              result_notes: `BOT-SIN-API: ${data?.error || 'pedido del bot de Dropi — gestionar en el panel'}`.slice(0, 300),
            }).eq('id', row.id);
          }
          throw new Error(res?.error?.message || data?.error || 'Dropi no confirmó el cambio');
        }
      } else {
        const res = await supabase.functions.invoke('dropi-change-carrier', {
          body: { mode: 'cancel', externalId: row.externalId, reason: 'Reintento manual' },
        });
        const data = res?.data as { ok?: boolean; canceled?: boolean; error?: string } | null | undefined;
        // Éxito estricto canceled:true (edge viejo sin redeploy cae a quote → fallo).
        if (res?.error || data?.ok === false || data?.canceled !== true) {
          throw new Error(res?.error?.message || data?.error || 'Dropi no confirmó la cancelación');
        }
      }
      // Éxito → promover la fila a 'synced' para que salga de la lista y el
      // cron no la re-toque. Best-effort: si RLS bloquea (fila de otra
      // operadora), el refetch la mantiene visible y el cron la cierra después.
      await supabase.from('order_results')
        .update({
          dropi_sync_status: 'synced',
          result_notes: `Reintento manual OK · antes: ${row.notes}`.slice(0, 300),
        })
        .eq('id', row.id);
      toast.success(`#${row.externalId} — ${row.result === 'conf' ? 'confirmación' : 'cancelación'} empujada a Dropi ✓`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`#${row.externalId} sigue sin llegar a Dropi: ${msg}`, { duration: 8000 });
    } finally {
      setBusyId(null);
      void load();
    }
  }, [busyId, load]);

  // Guards: sin tienda, sin primera carga o sin fallos → no estorbar la cola.
  if (!activeStoreId || !loaded || rows.length === 0) return null;

  const botCount = rows.filter(r => r.notes.startsWith(BOT_PREFIX)).length;

  return (
    <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-destructive/20 flex items-center justify-center flex-shrink-0">
          <CloudOff size={18} className="text-destructive" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-extrabold tabular-nums text-destructive">{rows.length}</span>
            <span className="text-sm font-semibold text-foreground">
              {rows.length === 1 ? 'gestión no llegó a Dropi' : 'gestiones no llegaron a Dropi'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Quedaron en el CRM pero Dropi las rechazó (últimos {WINDOW_DAYS} días). Podés reintentarlas acá.
            {botCount > 0 && <> {botCount} son del bot de Dropi — esas solo se gestionan en el panel de Dropi.</>}
          </p>
        </div>
        <button onClick={() => void load()} aria-label="Actualizar lista de fallos"
          className="h-8 w-8 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <RefreshCw size={13} className={refreshing ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />
        </button>
        <button onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Ocultar lista de gestiones fallidas' : 'Ver lista de gestiones fallidas'}
          className="h-8 px-3 rounded-lg border border-border bg-card text-xs font-medium text-foreground flex items-center gap-1 flex-shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {expanded ? 'Ocultar' : 'Ver lista'}
          {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-destructive/30 max-h-[22rem] overflow-y-auto bg-card/50 divide-y divide-border">
          {rows.map(r => {
            const isBot = r.notes.startsWith(BOT_PREFIX);
            return (
              <div key={r.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-foreground truncate">{r.nombre || 'Pedido'}</span>
                    {r.externalId && <span className="text-[10px] font-mono text-muted-foreground">#{r.externalId}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      r.result === 'conf' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
                    }`}>
                      {r.result === 'conf' ? 'Confirmación' : 'Cancelación'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{timeAgo(r.createdAt)}</span>
                  </div>
                  {r.notes && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate" title={r.notes}>
                      {shortReason(r.notes)}
                    </p>
                  )}
                </div>
                {isBot ? (
                  <span className="text-[10px] px-2 py-1 rounded-lg border border-warning/40 bg-warning/10 text-warning font-medium inline-flex items-center gap-1 flex-shrink-0">
                    <Bot size={11} aria-hidden="true" /> Pedido del bot — gestionar en panel Dropi
                  </span>
                ) : (
                  <button onClick={() => void retry(r)} disabled={busyId !== null || !r.externalId}
                    title={r.externalId
                      ? 'Volver a empujar esta gestión a Dropi'
                      : 'Pedido sin external_id — no se puede reintentar por API'}
                    className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-foreground hover:bg-muted/40 flex items-center gap-1 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    {busyId === r.id
                      ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" />
                      : <RefreshCw size={12} aria-hidden="true" />} Reintentar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
