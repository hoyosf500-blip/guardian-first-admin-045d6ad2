import { useCallback, useEffect, useState } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { supabase } from '@/integrations/supabase/client';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { EDIT_RESULTS, EDIT_LABEL, isDuplicadoVivo, editAppliedEvidence, parseFirstOrderRef } from '@/lib/dropiSyncFailures';
import { toast } from 'sonner';
import { CloudOff, ChevronDown, ChevronUp, RefreshCw, Loader2, Bot, Pencil, Copy } from 'lucide-react';

// Gestiones (conf/canc) Y ediciones (transportadora/valor/edición de orden)
// que quedaron en el CRM pero NUNCA llegaron a Dropi
// (order_results.dropi_sync_status='failed'). Antes eran invisibles: el toast
// mentía ("Aparecerá en Novedades") y nadie volvía a mirarlas. Este panel las
// hace visibles arriba de la cola de Confirmar, con reintento manual.
//
// Los pedidos del bot de Dropi (LucidBot/FINAL_ORDER) NO tienen superficie de
// escritura por API — reintentar es inútil eterno. Se marcan con el prefijo
// BOT-SIN-API: en result_notes y acá se muestran como badge informativo.
//
// Las EDICIONES no tienen retry automático (no guardamos el payload completo
// del intento): se muestran como aviso "reabrí el pedido y aplicala de nuevo".
// El botón Reintentar queda SOLO para conf/canc.

const BOT_PREFIX = 'BOT-SIN-API:';
const WINDOW_DAYS = 7;
const POLL_MS = 5 * 60_000; // poll suave — nada agresivo, la DB ya va justa

// Gestión OBSOLETA (2026-07-13): si el PEDIDO ya está muerto localmente
// (reemplazado por una hermana del forwarding de Dropi / cancelado / rechazado),
// la conf o edición que falló ya no tiene NADA que gestionar — el pedido real
// del cliente vive en otra fila que se gestionó aparte. Mostrarlas acá solo
// mete ruido (el 13-jul el panel gritaba "50" y 49 eran stubs REEMPLAZADA).
// OJO: para 'canc' el estado CANCELADO local NO la vuelve obsoleta — ese es
// justamente el objetivo del canc y la fila failed significa que Dropi aún no
// lo tiene (esa sí se reintenta / la cierra el cron al verificarla muerta).
const MOOT_CONF_EDIT_RE = /CANCELAD|REEMPLAZAD|RECHAZAD/i;
const MOOT_CANC_RE = /REEMPLAZAD|RECHAZAD/i;

function isMootRow(result: string, estado: string | null | undefined): boolean {
  const e = String(estado ?? '');
  if (!e) return false;
  return result === 'canc' ? MOOT_CANC_RE.test(e) : MOOT_CONF_EDIT_RE.test(e);
}

interface FailedGestion {
  id: string;
  orderId: string;
  result: string; // 'conf' | 'canc' | EDIT_RESULTS
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
  const [mootCount, setMootCount] = useState(0);
  const [appliedCount, setAppliedCount] = useState(0);
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
        .select('id, order_id, result, result_notes, created_at, dropi_sync_status')
        .eq('store_id', activeStoreId)
        .or(`dropi_sync_status.eq.failed,and(dropi_sync_status.eq.pending,created_at.lt."${stalePendingIso}")`)
        .in('result', ['conf', 'canc', ...EDIT_RESULTS])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        // 200 y no 50: el .limit corre en el SERVIDOR (DESC) ANTES del filtrado
        // cliente de moot/applied/dedupe. Tras una tanda de recreates (13-jul:
        // 50 filas, 49 stubs REEMPLAZADA) un top-50 podía ser TODO moot → una
        // cancelación genuina más vieja pero dentro de 7d nunca se cargaba y el
        // panel hacía return null ocultando pérdidas reales. Con 200 los fallos
        // accionables de 7d rara vez se pasan tras filtrar moot; el filtrado
        // cliente ya existente reduce a lo accionable. (No movemos moot al
        // server: depende de orders.estado, ausente en order_results → join grande.)
        .limit(200);
      if (error) throw error;

      // Una fila por (pedido, tipo de gestión) — la más reciente gana (la query
      // viene DESC). Dedupe por order_id solo escondía info: una conf fallida y
      // una edición fallida del MISMO pedido son problemas distintos.
      const byOrder = new Map<string, NonNullable<typeof data>[number]>();
      for (const r of data ?? []) {
        const key = `${r.order_id}:${r.result}`;
        if (!byOrder.has(key)) byOrder.set(key, r);
      }

      // Join liviano: resolver external_id/nombre/estado con una 2ª query por id IN.
      // (las keys del map son compuestas `${order_id}:${result}` — deduplicar acá)
      const meta = new Map<string, { externalId: string; nombre: string; estado: string; lastEditSyncAt: string | null }>();
      const orderIds = [...new Set([...byOrder.values()].map(r => r.order_id))];
      if (orderIds.length > 0) {
        const { data: ords } = await supabase
          .from('orders')
          .select('id, external_id, nombre, estado, last_edit_sync_at')
          .in('id', orderIds);
        for (const o of ords ?? []) {
          meta.set(o.id, {
            externalId: String(o.external_id ?? ''),
            nombre: o.nombre ?? '',
            estado: String((o as { estado?: string | null }).estado ?? ''),
            lastEditSyncAt: (o as { last_edit_sync_at?: string | null }).last_edit_sync_at ?? null,
          });
        }
      }

      // Filtrar las gestiones OBSOLETAS (pedido local muerto/reemplazado):
      // se cuentan aparte para transparencia, pero no piden acción a nadie.
      // EXENTAS las alertas de duplicado vivo: la hermana duplicada sigue viva
      // en DROPI aunque el pedido ANCLA local esté cancelado/reemplazado —
      // ocultarla por el estado local es el mismo modo de pérdida silenciosa
      // del incidente 2026-07-13.
      const all = [...byOrder.values()];
      const actionable = all.filter(r =>
        isDuplicadoVivo(r.result_notes ?? '') || !isMootRow(r.result, meta.get(r.order_id)?.estado)
      );
      setMootCount(all.length - actionable.length);

      // Supresión por EVIDENCIA (2026-07-13): si orders.last_edit_sync_at es
      // >= al created_at de la auditoría, la edición SÍ aplicó en Dropi (el
      // settle del cliente era no-op por RLS sin política UPDATE) — gritarla
      // como "no aplicada" es falso positivo. SOLO filas 'pending' (la clase
      // huérfana del bug de RLS): una fila 'failed' es un veredicto explícito
      // del settle y last_edit_sync_at es a nivel PEDIDO — una edición
      // POSTERIOR de otro tipo que sí aplicó la estamparía y ocultaría un
      // fallo genuino. EXENTAS también las alertas de duplicado vivo.
      const visible = actionable.filter(r => {
        if (isDuplicadoVivo(r.result_notes ?? '')) return true;
        if ((r as { dropi_sync_status?: string }).dropi_sync_status !== 'pending') return true;
        return !editAppliedEvidence(r.result, r.created_at, meta.get(r.order_id)?.lastEditSyncAt);
      });
      setAppliedCount(actionable.length - visible.length);
      setRows(visible.map(r => ({
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
    // Solo conf/canc tienen retry (el else de abajo CANCELA en Dropi — una
    // fila de edición acá cancelaría el pedido). Las ediciones van por badge.
    if (row.result !== 'conf' && row.result !== 'canc') return;
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
            // .select('id') para DETECTAR el no-op silencioso: si RLS vuelve a
            // bloquear el UPDATE (bug 2026-07-13, faltaba política UPDATE en
            // order_results), devuelve 0 filas y acá queda rastro visible.
            const { data: tagged } = await supabase.from('order_results').update({
              result_notes: `BOT-SIN-API: ${data?.error || 'pedido del bot de Dropi — gestionar en el panel'}`.slice(0, 300),
            }).eq('id', row.id).select('id');
            if ((tagged ?? []).length === 0) {
              console.warn('[DropiSyncFailures] tag BOT-SIN-API no actualizó filas (¿RLS de UPDATE rota de nuevo?)', row.id);
            }
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
      // .select('id') detecta el no-op silencioso (bug 2026-07-13: sin política
      // UPDATE en order_results el UPDATE por JWT devolvía 0 filas sin error).
      const { data: settled } = await supabase.from('order_results')
        .update({
          dropi_sync_status: 'synced',
          result_notes: `Reintento manual OK · antes: ${row.notes}`.slice(0, 300),
        })
        .eq('id', row.id)
        .select('id');
      if ((settled ?? []).length === 0) {
        console.warn('[DropiSyncFailures] settle a synced no actualizó filas (¿RLS de UPDATE rota de nuevo?)', row.id);
      }
      toast.success(`#${row.externalId} — ${row.result === 'conf' ? 'confirmación' : 'cancelación'} empujada a Dropi ✓`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`#${row.externalId} sigue sin llegar a Dropi: ${msg}`, { duration: 8000 });
    } finally {
      setBusyId(null);
      void load();
    }
  }, [busyId, load]);

  // Descartar manual SOLO para filas de edición / duplicado vivo: no tienen
  // retry (retry() hace early-return para todo lo que no sea conf/canc) ni
  // settle automático, así que la alerta "Cancelá el duplicado #X" / "reaplicá
  // la edición" gritaba por 7 días aunque ya la hubieran resuelto a mano. Este
  // botón promueve la fila a 'synced' con prefijo RESUELTO MANUAL: para que
  // deje de ser 'failed' y desaparezca del panel. NO toca el flujo de conf/canc.
  const resolveManual = useCallback(async (row: FailedGestion) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      // .select('id') detecta el no-op silencioso (mismo patrón que retry/settle:
      // sin política UPDATE en order_results el UPDATE por JWT devuelve 0 filas
      // sin error). Best-effort: si RLS bloquea, el refetch la mantiene visible.
      const { data: resolved } = await supabase.from('order_results')
        .update({
          dropi_sync_status: 'synced',
          result_notes: `RESUELTO MANUAL: ${row.notes}`.slice(0, 300),
        })
        .eq('id', row.id)
        .select('id');
      if ((resolved ?? []).length === 0) {
        console.warn('[DropiSyncFailures] resolveManual no actualizó filas (¿RLS de UPDATE rota?)', row.id);
        toast.error('No se pudo marcar como resuelta (permisos)');
      } else {
        toast.success(`#${row.externalId || row.orderId} marcada como resuelta ✓`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`No se pudo marcar como resuelta: ${msg}`);
    } finally {
      setBusyId(null);
      void load();
    }
  }, [busyId, load]);

  // Guards: sin tienda, sin primera carga o sin fallos → no estorbar la cola.
  if (!activeStoreId || !loaded || rows.length === 0) return null;

  const botCount = rows.filter(r => r.notes.startsWith(BOT_PREFIX)).length;

  return (
    /* Barra lateral de color + chip con halo: la fórmula de banner del DS.
       Antes el bloque se distinguía solo por el fondo rojo claro, que en tema
       claro casi no se separa de la card de al lado. */
    <div className="relative mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 shadow-card3d hairline-top overflow-hidden">
      <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger z-10" aria-hidden="true" />
      <div className="px-4 pl-5 py-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-destructive/30 to-destructive/12 border border-destructive/30 glow-danger flex items-center justify-center flex-shrink-0">
          <CloudOff size={18} className="text-destructive" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-3xl font-extrabold font-mono tabular-nums text-destructive leading-none num-glow-danger">{rows.length}</span>
            <span className="text-sm font-semibold text-foreground">
              {rows.length === 1 ? 'gestión o edición no llegó a Dropi' : 'gestiones y ediciones no llegaron a Dropi'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Quedaron en el CRM pero Dropi las rechazó (últimos {WINDOW_DAYS} días). Las gestiones se reintentan acá; las ediciones se reaplican desde el pedido.
            {botCount > 0 && <> {botCount} son del bot de Dropi — esas solo se gestionan en el panel de Dropi.</>}
            {mootCount > 0 && <> Se ocultaron {mootCount} obsoletas (el pedido fue reemplazado o cancelado — nada que hacer).</>}
            {appliedCount > 0 && <> · {appliedCount} ediciones se verificaron aplicadas en Dropi y se ocultaron.</>}
          </p>
        </div>
        <button onClick={() => void load()} aria-label="Actualizar lista de fallos"
          className="h-9 w-9 rounded-xl border border-border bg-card/60 flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 flex-shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <RefreshCw size={13} className={refreshing ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />
        </button>
        <button onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Ocultar lista de gestiones fallidas' : 'Ver lista de gestiones fallidas'}
          className="h-9 px-3 rounded-xl border border-border bg-card/60 text-xs font-medium text-foreground flex items-center gap-1 flex-shrink-0 hover:border-border-strong transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {expanded ? 'Ocultar' : 'Ver lista'}
          {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-destructive/30 max-h-[22rem] overflow-y-auto bg-card/50 divide-y divide-border">
          {rows.map(r => {
            const isBot = r.notes.startsWith(BOT_PREFIX);
            // Alerta de DUPLICADO VIVO (dropi-change-carrier detectó una hermana
            // viva en Dropi): NO es una edición de datos — la acción es cancelar
            // el duplicado, no reaplicar nada.
            const isDup = isDuplicadoVivo(r.notes);
            const isEdit = !isDup && (EDIT_RESULTS as readonly string[]).includes(r.result);
            // SOLO el id parseado de la nota: r.externalId NO sirve de fallback —
            // tras un recreate la fila ancla ya apunta a la orden NUEVA (la buena);
            // un CTA "Cancelá el duplicado #<buena>" haría cancelar el pedido correcto.
            const dupRef = isDup ? (parseFirstOrderRef(r.notes) ?? '') : '';
            return (
              <div key={r.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-foreground truncate">{r.nombre || 'Pedido'}</span>
                    {r.externalId && <span className="text-[10px] font-mono text-muted-foreground">#{r.externalId}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      isDup ? 'bg-destructive/15 text-destructive'
                        : isEdit ? 'bg-warning/15 text-warning'
                          : r.result === 'conf' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
                    }`}>
                      {isDup ? 'Duplicado vivo' : isEdit ? (EDIT_LABEL[r.result] ?? 'Edición') : r.result === 'conf' ? 'Confirmación' : 'Cancelación'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{timeAgo(r.createdAt)}</span>
                  </div>
                  {r.notes && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate" title={r.notes}>
                      {shortReason(r.notes)}
                    </p>
                  )}
                </div>
                {isDup ? (
                  // La acción es CANCELAR el duplicado vivo, no reaplicar nada.
                  // Link directo a la ficha del duplicado (id de la nota, o el
                  // propio pedido si la nota no trae referencia). + botón para
                  // descartar la alerta una vez resuelta a mano (no tiene retry).
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {dupRef ? (
                      <a href={`/pedido/${dupRef}`}
                        className="text-[10px] px-2 py-1 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive font-medium inline-flex items-center gap-1 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                        <Copy size={11} aria-hidden="true" /> Cancelá el duplicado #{dupRef}
                      </a>
                    ) : (
                      <span className="text-[10px] px-2 py-1 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive font-medium inline-flex items-center gap-1">
                        <Copy size={11} aria-hidden="true" /> Cancelá el duplicado en el panel de Dropi
                      </span>
                    )}
                    <button onClick={() => void resolveManual(r)} disabled={busyId !== null}
                      title="Marcar como resuelta y quitar del panel"
                      className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-foreground hover:bg-muted/40 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      {busyId === r.id ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" /> : null} Ya lo resolví
                    </button>
                  </div>
                ) : isEdit ? (
                  // Sin retry automático posible: no guardamos el payload del
                  // intento. La asesora reabre el pedido y la aplica de nuevo. +
                  // botón para descartar la alerta una vez reaplicada a mano.
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {r.externalId ? (
                      <a href={`/pedido/${r.externalId}`}
                        className="text-[10px] px-2 py-1 rounded-lg border border-warning/40 bg-warning/10 text-warning font-medium inline-flex items-center gap-1 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                        <Pencil size={11} aria-hidden="true" /> Edición no aplicada en Dropi — reabrí el pedido y aplicala de nuevo
                      </a>
                    ) : (
                      <span className="text-[10px] px-2 py-1 rounded-lg border border-warning/40 bg-warning/10 text-warning font-medium inline-flex items-center gap-1">
                        <Pencil size={11} aria-hidden="true" /> Edición no aplicada en Dropi — reabrí el pedido y aplicala de nuevo
                      </span>
                    )}
                    <button onClick={() => void resolveManual(r)} disabled={busyId !== null}
                      title="Marcar como resuelta y quitar del panel"
                      className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-foreground hover:bg-muted/40 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      {busyId === r.id ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" /> : null} Ya lo resolví
                    </button>
                  </div>
                ) : isBot ? (
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
