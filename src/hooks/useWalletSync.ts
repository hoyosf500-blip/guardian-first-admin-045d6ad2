import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Sync de billetera Dropi — RUNS IN THE BROWSER, no en edge function.
//
// Por qué browser: Dropi bloquea `/api/*` (endpoints de user-session) por
// IP de data center. La edge function recibía 403 Access denied. El browser
// del admin tiene IP residencial → Dropi acepta. Verificado 2026-04-29
// con Playwright fetch test (server 403, browser 200).
//
// Este hook:
//   1. Lee dropi_session_token de app_settings (RLS admin)
//   2. Decodifica JWT (sub = user_id Dropi, exp = expiración)
//   3. Pagina GET /api/historywallet con start/result_number=100
//   4. Mapea cada movimiento al shape de la RPC
//   5. Llama supabase.rpc('upsert_wallet_movements') por batch (idempotente)
//   6. Inserta en sync_logs para auditoría
//
// La edge function `dropi-wallet-sync` queda en el repo como backup —
// utilizable si en el futuro montamos un proxy residencial.

export interface WalletSyncResult {
  ok: boolean;
  synced?: number;
  total?: number;
  dropi_user_id?: number;
  error?: string;
  expired?: boolean;
  message?: string;
}

interface DropiMovementRaw {
  id?: number;
  amount?: string | number;
  type?: string;
  created_at?: string;
  previous_amount?: string | number;
  description?: string;
  identification_code?: string;
  account?: string | null;
  withdrawal_concept?: string | null;
  [k: string]: unknown;
}

interface DropiHistoryResponse {
  isSuccess?: boolean;
  status?: number;
  count?: number;
  objects?: DropiMovementRaw[];
  message?: string;
}

const DROPI_API = 'https://api.dropi.co';
const PAGE_SIZE = 100;

function mapCategoria(codigo: string): string {
  const c = (codigo || '').toUpperCase();
  if (!c) return 'otro';
  if (c.includes('FLETE INICIAL'))                                 return 'flete_inicial';
  if (c.includes('NUEVA ORDEN'))                                   return 'orden_sin_recaudo';
  if (c.includes('CAMBIO DE ESTATUS'))                             return 'cobro_entrega';
  if (c.includes('GANANCIA') && c.includes('DROPSHIPPER'))         return 'ganancia_dropshipper';
  if (c.includes('GANANCIA') && c.includes('PROVEEDOR'))           return 'ganancia_proveedor';
  if (c.includes('DEVOLUCION DE FLETE ORDEN ENTREGADA'))           return 'reembolso_flete';
  if (c.includes('DEVOLUCION DE FLETE') && c.includes('NO EFECTIVA')) return 'costo_devolucion';
  if (c.includes('COMISION DE REFERIDOS'))                         return 'comision_referidos';
  if (c.includes('RETIRO'))                                        return 'retiro';
  if (c.includes('DEPOSITO') || c.includes('DEPÓSITO') || c.includes('RECARGA')) return 'deposito';
  return 'otro';
}

function extractOrderId(desc: string | undefined | null): string | null {
  if (!desc) return null;
  // Las descripciones de Dropi vienen como:
  // "ENTRADA POR GANANCIA EN LA ORDEN COMO DROPSHIPPER: 73130105* GUIA: *240051035639*"
  // El número INMEDIATAMENTE después del primer ":" es el order_id.
  // Si no encuentra ese patrón, cae al primer número de 6+ dígitos.
  const colonMatch = String(desc).match(/:\s*(\d{6,})/);
  if (colonMatch) return colonMatch[1];
  const anyMatch = String(desc).match(/(\d{6,})/);
  return anyMatch ? anyMatch[1] : null;
}

function decodeJwt(jwt: string): { sub: number; exp: number } | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return { sub: Number(payload.sub), exp: Number(payload.exp || 0) };
  } catch {
    return null;
  }
}

interface MappedMovement {
  dropi_transaction_id: number;
  fecha: string;
  tipo: string;
  codigo: string | null;
  categoria: string;
  monto: number;
  monto_previo: number | null;
  saldo_despues: number | null;
  descripcion: string | null;
  cuenta: string | null;
  concepto_retiro: string | null;
  related_order_id: string | null;
  raw: DropiMovementRaw;
  synced_by: string;
}

function mapMovement(m: DropiMovementRaw, syncedBy: string): MappedMovement | null {
  const id = Number(m.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const tipo = String(m.type ?? '').toUpperCase().trim() || 'SALIDA';
  const codigo = String(m.identification_code ?? '').trim();
  const monto = Math.abs(Number(m.amount ?? 0));
  const montoPrevio = m.previous_amount !== undefined && m.previous_amount !== null
    ? Number(m.previous_amount)
    : null;
  const saldoDespues = montoPrevio !== null
    ? (tipo === 'ENTRADA' ? montoPrevio + monto : montoPrevio - monto)
    : null;
  const descripcion = m.description ? String(m.description) : null;

  return {
    dropi_transaction_id: id,
    fecha: String(m.created_at ?? new Date().toISOString()),
    tipo,
    codigo: codigo || null,
    categoria: mapCategoria(codigo),
    monto,
    monto_previo: montoPrevio,
    saldo_despues: saldoDespues,
    descripcion,
    cuenta: m.account ? String(m.account) : null,
    concepto_retiro: m.withdrawal_concept ? String(m.withdrawal_concept) : null,
    related_order_id: extractOrderId(descripcion),
    raw: m,
    synced_by: syncedBy,
  };
}

async function fetchDropiPage(
  jwt: string,
  dropiUserId: number,
  from: string,
  to: string,
  start: number,
): Promise<DropiMovementRaw[]> {
  const params = new URLSearchParams({
    orderBy: 'id',
    orderDirection: 'desc',
    result_number: String(PAGE_SIZE),
    start: String(start),
    textToSearch: '',
    type: 'null',
    id: 'null',
    identification_code: 'null',
    user_id: String(dropiUserId),
    from,
    until: to,
    wallet_id: '0',
  });

  const res = await fetch(`${DROPI_API}/api/historywallet?${params.toString()}`, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'x-authorization': `Bearer ${jwt}`,
    },
  });

  if (res.status === 401 || res.status === 403) {
    const txt = await res.text();
    const expired = res.status === 401;
    const err = new Error(expired ? 'EXPIRED' : `Dropi denegó acceso (${res.status}): ${txt.slice(0, 200)}`);
    (err as Error & { expired?: boolean }).expired = expired;
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Dropi error ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = (await res.json()) as DropiHistoryResponse;
  if (data.isSuccess === false) {
    throw new Error(data.message || 'Dropi devolvió isSuccess=false');
  }
  return Array.isArray(data.objects) ? data.objects : [];
}

export function useWalletSync() {
  const qc = useQueryClient();

  return useMutation<WalletSyncResult, Error, { from?: string; untill?: string; limit?: number } | undefined>({
    mutationFn: async (body) => {
      const today = new Date();
      const past = new Date();
      past.setDate(past.getDate() - 30);
      const b = body ?? {};
      const fromDate = b.from ?? past.toISOString().split('T')[0];
      const toDate = b.untill ?? today.toISOString().split('T')[0];
      const limit = Number(b.limit || 0);

      // 1. Auth Supabase del caller
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        return { ok: false, error: 'No autenticado' };
      }

      // 2. Leer JWT de Dropi de app_settings (RLS admin)
      const { data: tokenRow, error: tokenErr } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'dropi_session_token')
        .maybeSingle();

      if (tokenErr) {
        return { ok: false, error: `No pude leer dropi_session_token: ${tokenErr.message}` };
      }
      const jwt = tokenRow?.value || '';
      if (!jwt) {
        return {
          ok: false,
          error: 'Token de sesión Dropi no configurado. Ve a Admin → Token sesión Dropi.',
        };
      }

      // 3. Decode JWT + check expiration localmente (ahorra una llamada a Dropi)
      const decoded = decodeJwt(jwt);
      if (!decoded) {
        return { ok: false, error: 'Token de sesión Dropi inválido — no se pudo decodificar.' };
      }
      if (decoded.exp > 0 && decoded.exp * 1000 < Date.now()) {
        return {
          ok: false,
          expired: true,
          error: 'Token de sesión Dropi expirado. Refrescá en Admin → Token sesión Dropi.',
        };
      }

      // 4. Paginar Dropi (browser → IP residencial → no 403)
      let totalFromDropi = 0;
      let totalSynced = 0;
      let start = 0;
      // Cap defensivo: 50 páginas × 100 = 5000 movimientos por sync.
      const MAX_PAGES = 50;
      let page = 0;

      try {
        outer: while (page < MAX_PAGES) {
          const items = await fetchDropiPage(jwt, decoded.sub, fromDate, toDate, start);
          if (items.length === 0) break;

          const mapped: MappedMovement[] = items
            .map((m) => mapMovement(m, user.id))
            .filter((m): m is MappedMovement => m !== null);

          totalFromDropi += mapped.length;

          // 5. Upsert idempotente en batches de 50
          for (let i = 0; i < mapped.length; i += 50) {
            const batch = mapped.slice(i, i + 50);
            const { data: changedCount, error: upsertError } = await supabase.rpc(
              'upsert_wallet_movements',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { p_movements: batch as any },
            );
            if (upsertError) {
              console.error('upsert_wallet_movements error:', upsertError);
            } else {
              totalSynced += (changedCount as number) || 0;
            }
          }

          if (limit > 0 && totalFromDropi >= limit) break outer;
          if (items.length < PAGE_SIZE) break;
          start += PAGE_SIZE;
          page += 1;
        }
      } catch (err) {
        const e = err as Error & { expired?: boolean };
        if (e.expired) {
          return { ok: false, expired: true, error: e.message };
        }
        throw err;
      }

      // 6. Log a sync_logs para auditoría
      await supabase.from('sync_logs').insert({
        source: 'dropi-wallet-sync-browser',
        status: 'success',
        synced_count: totalSynced,
        duplicates_count: 0,
        total_count: totalFromDropi,
        triggered_by: user.id,
      });

      return {
        ok: true,
        synced: totalSynced,
        total: totalFromDropi,
        dropi_user_id: decoded.sub,
        message: `${totalSynced} movimientos guardados de ${totalFromDropi} traídos`,
      };
    },
    onSuccess: (data) => {
      if (data.ok) {
        toast.success(`Sync OK: ${data.synced ?? 0} movimientos sincronizados (${data.total ?? 0} traídos).`);
        qc.invalidateQueries({ queryKey: ['wallet_movements'] });
        qc.invalidateQueries({ queryKey: ['wallet_daily_series'] });
      } else if (data.expired) {
        toast.error('Token Dropi expirado. Refrescá en Admin → Token sesión Dropi.');
      } else {
        toast.error(`Sync falló: ${data.error ?? 'error desconocido'}`);
      }
    },
    onError: (err) => {
      const expired = (err as Error & { expired?: boolean }).expired;
      if (expired) {
        toast.error('Token Dropi expirado. Refrescá en Admin → Token sesión Dropi.');
      } else {
        toast.error(`Error: ${err.message}`);
      }
    },
  });
}
