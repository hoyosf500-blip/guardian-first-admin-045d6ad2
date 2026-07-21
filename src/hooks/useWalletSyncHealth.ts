import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Hook para detectar staleness del wallet de Dropi.
//
// FIX 2026-06-23 — antes medíamos max(synced_at) de dropi_wallet_movements (la
// última FILA upserteada) y max(fecha) (el último movimiento), tomando el PEOR de
// los dos. En una tienda de baja actividad NO entran movimientos nuevos, así que
// max(fecha) es viejo por naturaleza y el UPSERT idempotente
// (ON CONFLICT … WHERE … IS DISTINCT FROM, migration 20260430000000:110-127) NO
// re-bumpea synced_at cuando la fila no cambió → ambas señales envejecían y el
// badge marcaba "stale"/"critical" aunque el cron corriera sano cada 6h. Confundía
// "no hay actividad nueva" con "el sync se rompió".
//
// Ahora anclamos la frescura a la ÚLTIMA CORRIDA del cron del wallet, que se
// registra en sync_logs (source='dropi-wallet-sync') en CADA corrida — incluso si
// trajo 0 movimientos nuevos (dropi-wallet-sync/index.ts:262). Si el cron deja de
// correr no se inserta fila nueva → lastSyncAt envejece → stale/critical, que es
// lo que de verdad importa. Bonus: sync_logs es legible por socios (policy
// is_store_member, migration 20260623120000); dropi_wallet_movements es admin-only
// (wallet_admin_select), así que el badge viejo NUNCA funcionó para socios — ahora sí.
//
// FIX 2026-07-21 — EL CRON PODÍA FALLAR EN VERDE.
//
// Hasta hoy la query pedía SOLO `created_at`: medía que el cron se hubiera
// EJECUTADO, nunca si había funcionado. El cron del wallet estuvo fallando en
// TODAS sus corridas, cada 6 horas, en las dos tiendas (`invalid input syntax
// for type uuid: ""`) — y como se ejecutaba puntualmente, el badge decía
// "Sincronizado hace 2h" en VERDE. La billetera quedó clavada 15 días (último
// movimiento 7-jul en EC, 26-jun en CO) y el dueño estuvo mirando la misma
// ganancia creyendo que era real.
//
// Ahora también se lee `status`: una corrida que terminó en error es 'failing',
// por reciente que sea. "Corrió" y "funcionó" son dos preguntas distintas.
//
// Devuelve un status simbólico que el badge usa para colorear:
//   fresh     → corrió < 8h y sin error   (verde)
//   stale     → corrió 8h-24h             (amarillo, warning)
//   critical  → corrió > 24h              (rojo, cron caído)
//   failing   → la última corrida FALLÓ   (rojo, el cron corre pero no guarda)
//   never     → sin corridas              (gris)

export type WalletSyncStatus = 'fresh' | 'stale' | 'critical' | 'failing' | 'never';

export interface WalletSyncHealth {
  /** Última CORRIDA del cron del wallet (sync_logs), no la última fila upserteada. */
  lastSyncAt: Date | null;
  hoursSinceSync: number | null;
  // Horas desde el último movimiento del wallet (max fecha). INFORMATIVO: ya NO
  // dirige el color — una tienda sin movimientos nuevos no está "rota". Admin-only
  // por RLS (wallet_admin_select); para socios queda en null sin romper el badge.
  hoursSinceNewMovement: number | null;
  /** Mensaje de error de la última corrida, si falló. Para el tooltip. */
  lastErrorMessage: string | null;
  status: WalletSyncStatus;
}

const FRESH_HOURS = 8;
const STALE_HOURS = 24;

// Pura y exportada para testear.
//
// El color NO depende de si hubo movimientos nuevos (ese era el bug de 2026-06:
// una tienda de baja actividad envejecía aunque el cron estuviera sano). Sí
// depende de si la última corrida terminó bien — eso es lo que faltaba.
export function deriveStatus(
  hoursSinceRun: number | null,
  lastRunStatus?: string | null,
): WalletSyncStatus {
  if (hoursSinceRun === null) return 'never';
  // Una corrida fallida manda sobre la frescura: da igual que haya sido hace
  // 5 minutos si no guardó nada.
  if (lastRunStatus === 'error') return 'failing';
  if (hoursSinceRun < FRESH_HOURS) return 'fresh';
  if (hoursSinceRun < STALE_HOURS) return 'stale';
  return 'critical';
}

// `storeId` scopea la frescura a la TIENDA activa. Sin esto, un admin (que por
// RLS ve todas las tiendas) veía la corrida más reciente de CUALQUIER tienda → el
// badge marcaba "fresh" aunque la tienda que está mirando estuviera vieja (falsa
// tranquilidad). Pasá `activeStoreId` desde StoreContext.
export function useWalletSyncHealth(storeId?: string | null) {
  return useQuery<WalletSyncHealth>({
    queryKey: ['wallet_sync_health', storeId ?? 'all'],
    queryFn: async () => {
      // 1) Última corrida del cron del wallet — la fuente de verdad de "¿corrió?".
      //    source='dropi-wallet-sync' la distingue del sync de ÓRDENES
      //    (source='dropi'), que comparte la misma tabla sync_logs.
      let runQ = supabase
        .from('sync_logs')
        // `status` y `error_message` NO son decorativos: sin ellos una corrida
        // fallida es indistinguible de una exitosa (ver el FIX del encabezado).
        .select('created_at, status, error_message')
        .eq('source', 'dropi-wallet-sync')
        .order('created_at', { ascending: false })
        .limit(1);
      // 2) Último movimiento (informativo, best-effort: dropi_wallet_movements es
      //    admin-only, así que para socios esta query falla y la tratamos como null).
      let fechaQ = supabase
        .from('dropi_wallet_movements')
        .select('fecha')
        .order('fecha', { ascending: false })
        .limit(1);
      if (storeId) {
        runQ = runQ.eq('store_id', storeId);
        fechaQ = fechaQ.eq('store_id', storeId);
      }
      const [runRes, fechaRes] = await Promise.all([
        runQ.maybeSingle(),
        fechaQ.maybeSingle(),
      ]);
      // El run query SÍ es crítico: si falla, que el badge se oculte (isError).
      if (runRes.error) throw runRes.error;
      // El fecha query NO es crítico — un socio sin permiso no debe romper el badge.
      const tsRun = runRes.data?.created_at ? new Date(runRes.data.created_at) : null;
      const tsNew = !fechaRes.error && fechaRes.data?.fecha ? new Date(fechaRes.data.fecha) : null;
      const hoursSinceRun = tsRun ? (Date.now() - tsRun.getTime()) / 3_600_000 : null;
      const hoursNew = tsNew ? (Date.now() - tsNew.getTime()) / 3_600_000 : null;
      const lastRunStatus = (runRes.data as { status?: string } | null)?.status ?? null;
      const lastErrorMessage = (runRes.data as { error_message?: string } | null)?.error_message ?? null;
      return {
        lastSyncAt: tsRun,
        hoursSinceSync: hoursSinceRun,
        hoursSinceNewMovement: hoursNew,
        lastErrorMessage,
        status: deriveStatus(hoursSinceRun, lastRunStatus),
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
