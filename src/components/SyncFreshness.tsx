import { useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, WifiOff, RefreshCw, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { textoCadencia } from '@/lib/cadenciaSync';
import { useStore } from '@/contexts/StoreContext';
import { toast } from 'sonner';

/**
 * Banner de salud del sync por tienda. 3 estados:
 *  - verde:   última sync 'success' con synced_count>0 en últimas 24h
 *  - amarillo: todas las corridas de la última hora con synced_count=0 OR
 *              status='warn' (zombie detectado por dropi-cron)
 *  - rojo:    última sync 'error' O > 60 min sin attempt
 *
 * Crítico: el amarillo es la pieza que NO existía antes — del 21/05 al 28/05
 * todo decía verde "hace 5 min" mientras el cron devolvía 0 silenciosamente.
 *
 * FRESCURA VISIBLE (2026-07-13): el verde era un puntito "Sync OK" con la info
 * ("hace X min · N cambios") escondida en un tooltip → el dueño no la veía y
 * dudaba de los datos aunque estuvieran frescos. Ahora el verde es una píldora
 * LEGIBLE: "Sincronizado con Dropi · hace X min · N pedidos actualizados", con
 * el "hace X" ticando en vivo (timer local de 30s) y un PULSO "en vivo" cuando
 * llega un cambio realtime — para que se VEA que la data se mueve sola.
 */

type Color = 'green' | 'yellow' | 'red';

interface LogRow {
  status: string;
  synced_count: number;
  total_count: number;
  created_at: string;
  error_message: string | null;
}

interface Props {
  /** Callback opcional para abrir el modal de auditoría desde el banner amarillo. */
  onAuditClick?: () => void;
}

/** "hace 3 min" / "hace 2 h" / "recién" — relativo humano y corto. */
function relTime(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export default function SyncFreshness({ onAuditClick }: Props) {
  const { activeStoreId, isManagerOfActive, isOwnerOfActive } = useStore();
  const qc = useQueryClient();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Reloj local: re-renderiza cada 30s para que "hace X min" nunca quede viejo
  // entre recargas de sync_logs (el poll es cada 2 min).
  const [, setNowTick] = useState(0);
  const [leerFallo, setLeerFallo] = useState(false);

  const load = useCallback(async () => {
    if (!activeStoreId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('sync_logs')
      .select('status, synced_count, total_count, created_at, error_message')
      .eq('store_id', activeStoreId)
      // Frescura del sync de ÓRDENES = cron automático (source='dropi-cron', cada
      // 5 min) + syncs manuales (source='dropi'). ANTES filtraba solo 'dropi' →
      // ignoraba el cron y mostraba rojo falso "Sin sync hace X min" aunque el cron
      // corriera bien. Excluye wallet ('dropi-wallet-sync') y acciones por-pedido.
      .in('source', ['dropi-cron', 'dropi'])
      .order('created_at', { ascending: false })
      .limit(12);
    // ⛔ El error se tragaba (4-sep-2026): con la base lenta, `logs` quedaba
    // vacío y el componente devolvía null — ni pastilla verde ni banner rojo,
    // justo cuando el cron también suele estar caído. La ausencia de banner se
    // leía igual que "cargando". Ahora la lectura fallida se dice.
    setLeerFallo(Boolean(error));
    if (error) console.warn('[SyncFreshness] no se pudo leer sync_logs:', error.message);
    setLogs(error ? [] : ((data as LogRow[]) || []));
    setLoading(false);
  }, [activeStoreId]);

  useEffect(() => {
    void load();
    // Poll de respaldo (el realtime de abajo lo mantiene fresco en vivo).
    const id = setInterval(() => { void load(); }, 2 * 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Reloj local para el relativo "hace X min" (no toca la red).
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ⛔ ACÁ VIVÍA UN CUARTO BUCLE (quitado 28-ago-2026).
  //
  // Este banner montaba su PROPIO canal de realtime sobre `orders` y, con
  // debounce de 1,5 s, recargaba `sync_logs`. Como vive en el layout, corría en
  // TODAS las pantallas — y el cron de Dropi escribe en `orders` sin parar, así
  // que recargaba cada segundo y medio, para siempre. Medido con la pantalla
  // quieta: **11 peticiones a `sync_logs` por minuto** que no las pedía nadie.
  //
  // Escuchaba además la tabla equivocada: se suscribía a `orders` para
  // enterarse de algo de `sync_logs`, que ni siquiera está publicada en
  // realtime. Era un proxy, no una señal.
  //
  // El poll de 2 min de arriba y el reloj local de 30 s alcanzan: el número
  // puede quedar hasta 2 minutos viejo, pero el texto va FECHADO ("hace X min"),
  // así que nunca afirma una frescura que no tiene. Se pierde inmediatez en un
  // rótulo; se gana que la base deje de trabajar para nadie.

  const handleRetry = async () => {
    if (retrying || !activeStoreId) return;
    setRetrying(true);
    const t = toast.loading('Sincronizando pedidos…');
    try {
      // Mismo call que el botón "Sincronizar" (useResumenSync): dropi-sync para
      // ESTA tienda, store-scoped (gate = dueño), rápido (1 tienda). Escribe
      // sync_logs source='dropi' que ESTE banner sí lee → se actualiza al toque.
      const fmt = (d: Date) => d.toISOString().split('T')[0];
      const to = new Date();
      const from = new Date(to);
      from.setDate(from.getDate() - 30);
      const { data, error } = await supabase.functions.invoke('dropi-sync', {
        body: { store_id: activeStoreId, from: fmt(from), untill: fmt(to) },
      });
      const d = data as { error?: string; rateLimited?: boolean; message?: string } | null;
      if (error) throw new Error(error.message);
      if (d?.rateLimited) throw new Error(d.message || 'Dropi está limitando (rate limit). Probá en un minuto.');
      if (d?.error) throw new Error(d.error);
      toast.success('Pedidos sincronizados.', { id: t });
      // Refrescar el banner Y las cards del resumen (no solo la frescura).
      for (const k of ['orders-estado-breakdown', 'logistics', 'orders-sync-health', 'ganancia-neta-dropi']) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo sincronizar', { id: t });
    } finally {
      setRetrying(false);
    }
  };

  if (!activeStoreId) return null;
  if (leerFallo) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11px] font-semibold text-warning"
        title="No se pudo leer sync_logs: no sé si los pedidos están al día. Reintentá en un momento."
      >
        Estado del sync: no se pudo leer
      </span>
    );
  }
  if (logs.length === 0) return null;

  const now = Date.now();
  const last = logs[0];
  const lastAttemptAgeMin = (now - new Date(last.created_at).getTime()) / 60000;
  const lastSuccess = logs.find((l) => l.status === 'success' && l.synced_count > 0);
  const lastSuccessAgeHrs = lastSuccess
    ? (now - new Date(lastSuccess.created_at).getTime()) / 3600000
    : Infinity;
  const recentHour = logs.filter(
    (l) => (now - new Date(l.created_at).getTime()) / 60000 < 60,
  );
  const recentAllZeroOrWarn = recentHour.length > 0
    && recentHour.every((l) => l.synced_count === 0 || l.status === 'warn');
  const lastIsError = last.status === 'error';

  let color: Color;
  if (lastIsError || lastAttemptAgeMin > 60) color = 'red';
  else if (recentAllZeroOrWarn || lastSuccessAgeHrs > 24) color = 'yellow';
  else color = 'green';

  // VERDE — píldora VISIBLE y CALMA (antes era un puntito con la info en tooltip).
  // Muestra la última corrida del cron. SIN animaciones ni parpadeos (el dueño
  // reportó que los parpadeos molestaban): solo texto que se actualiza en
  // silencio. El tablero se mueve solo por el realtime de OrderContext; este
  // banner solo informa que la sincronización está al día.
  if (color === 'green') {
    const lastRunMs = now - new Date(last.created_at).getTime();
    const cadencia = textoCadencia(logs, now);
    // Cambios de la última corrida CON novedades (el synced_count de la más
    // reciente que trajo algo) — "N pedidos actualizados".
    const cambios = lastSuccess?.synced_count ?? 0;
    return (
      <div className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-full border border-success/30 bg-success/[0.06] px-3 py-1">
        <CheckCircle2 size={15} className="text-success flex-shrink-0" aria-hidden />
        <span className="text-xs font-semibold text-success">Sincronizado con Dropi</span>
        <span className="text-[11px] text-muted-foreground">
          · última revisión {relTime(lastRunMs)}
          {cambios > 0 && lastSuccess && (
            <> · {cambios} {cambios === 1 ? 'pedido actualizado' : 'pedidos actualizados'}</>
          )}
          {/* La cadencia se MIDE sobre las corridas reales de esta tienda.
              Acá decía, en texto fijo, "se actualiza solo cada 5 min": medido
              el 21-ago-2026, el cron corre cada 10 min y reparte el presupuesto
              entre tiendas, o sea ~20 min por tienda. Prometer 5 es lo que hace
              que un pedido se lea como "desactualizado": la asesora espera el
              cambio, no llega, y culpa a Guardian. Si no se puede medir, no se
              dice nada — ver el guardián en cadenciaSync.test.ts. */}
          {cadencia && <> · {cadencia}</>}
        </span>
      </div>
    );
  }

  if (color === 'yellow') {
    // Distinguir "throttle de Dropi" de "zombie / datos viejos": si alguna de
    // las corridas recientes trae un error_message de rate-limit, la causa es
    // el throttle EC (esperar), no un bug de datos → copy distinto y sin empujar
    // a "Auditar paridad" (auditoría EC 2026-07-07). La fila ya trae error_message.
    const recentErr = recentHour.map((l) => l.error_message).find(Boolean) || last.error_message;
    const isThrottle = !!recentErr && /throttle|429|rate.?limit|too many/i.test(recentErr);
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 flex items-center gap-3">
        <AlertTriangle size={16} className="text-warning flex-shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-warning">
            {isThrottle ? 'Dropi está limitando la sincronización' : 'Sync corriendo pero sin novedades'}
          </p>
          <p className="text-[11px] text-muted-foreground truncate" title={recentErr || undefined}>
            {isThrottle
              ? 'La cuenta está throttleada (rate-limit). Reintenta solo; no hace falta auditar.'
              : recentErr
                ? recentErr
                : `Las últimas ${recentHour.length} corridas no trajeron cambios. ¿Sospechás datos viejos?`}
          </p>
        </div>
        {onAuditClick && isManagerOfActive && !isThrottle && (
          <button
            onClick={onAuditClick}
            className="text-xs font-semibold text-warning hover:underline whitespace-nowrap cursor-pointer"
          >
            Auditar paridad →
          </button>
        )}
      </div>
    );
  }

  // red
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 flex items-center gap-3">
      <WifiOff size={16} className="text-destructive flex-shrink-0" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-destructive">
          {lastIsError ? 'Sync con error' : `Sin sync hace ${Math.round(lastAttemptAgeMin)} min`}
        </p>
        {last.error_message && (
          <p className="text-[11px] text-muted-foreground truncate" title={last.error_message}>
            {last.error_message}
          </p>
        )}
      </div>
      {/* Solo el DUEÑO: dropi-sync es owner-only. Un supervisor que apretaba
          "Reintentar manual" recibía 403. */}
      {isOwnerOfActive && (
        <button
          onClick={handleRetry}
          disabled={retrying || loading}
          className="inline-flex items-center gap-1 text-xs font-semibold text-destructive hover:underline whitespace-nowrap cursor-pointer disabled:opacity-50"
        >
          {retrying ? <RefreshCw size={11} className="animate-spin" /> : null}
          Reintentar manual
        </button>
      )}
    </div>
  );
}
