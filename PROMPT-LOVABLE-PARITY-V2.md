# Prompt #2 para Lovable — Cerrar las 3 capas UI + 2 GAPs

```
Continuamos el plan PLAN-PARITY-DROPI.md. Ya desplegaste backend (Capas 1+5)
correctamente — el cron ahora trae pedidos (verificado: synced=1785 en una
corrida). Quedan 3 capas UI y 2 GAPs detectados en el review.

═══════════════════════════════════════════════════════════════
GAP C (URGENTE) — pg_cron schedule no se aplicó
═══════════════════════════════════════════════════════════════

Síntoma: en store_dropi_config, last_health_status='unknown' y
last_health_checked_at=null para todas las tiendas. dropi-health nunca corrió.
nightly_reconcile_results está vacía.

ARCHIVO NUEVO: supabase/migrations/20260528180000_schedule_health_reconcile.sql

-- Schedule dropi-health cada hora
SELECT cron.schedule(
  'dropi-health-hourly',
  '0 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-health',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT value FROM app_settings WHERE key = 'cron_shared_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);

-- Schedule dropi-nightly-reconcile a las 3am UTC
SELECT cron.schedule(
  'dropi-nightly-reconcile',
  '0 3 * * *',
  $$
    SELECT net.http_post(
      url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-nightly-reconcile',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT value FROM app_settings WHERE key = 'cron_shared_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);

Importante: aplicar con `supabase db push`. Después verificar con:
SELECT jobname, schedule FROM cron.job
WHERE jobname IN ('dropi-health-hourly','dropi-nightly-reconcile');

═══════════════════════════════════════════════════════════════
GAP A — filter_date_by hardcoded en health + reconcile
═══════════════════════════════════════════════════════════════

dropi-cron auto-cura cuando Dropi cambia el valor (STATUS_FILTER_VARIANTS chain).
Pero dropi-health (línea 47) y dropi-nightly-reconcile (línea 41) lo tienen
hardcoded → si Dropi vuelve a cambiarlo, fallan silenciosamente.

FIX: dropi-cron escribe el winner a app_settings; health y reconcile lo leen.

ARCHIVO: supabase/functions/dropi-cron/index.ts
- Cuando `winningStatusFilter !== null` (ya hay ganadora del run), persistirla:
  await sb.from("app_settings").upsert({
    key: 'dropi_winning_status_filter',
    value: winningStatusFilter,
    updated_at: new Date().toISOString()
  });
- Al inicio del run, leer el valor previo:
  const { data: prev } = await sb.from("app_settings")
    .select("value").eq("key", "dropi_winning_status_filter").maybeSingle();
  if (prev?.value) STATUS_FILTER_VARIANTS.unshift(prev.value);  // arranca por el último ganador

ARCHIVO: supabase/functions/dropi-health/index.ts
- Reemplazar el filter_date_by hardcoded de las dos URLs por una lectura previa:
  const { data: cfg } = await sb.from("app_settings")
    .select("value").eq("key", "dropi_winning_status_filter").maybeSingle();
  const FILTER = cfg?.value || "FECHA DE CAMBIO DE ESTATUS";
- Y construir la URL con ese FILTER.

ARCHIVO: supabase/functions/dropi-nightly-reconcile/index.ts
- Idem: reemplazar la línea 41 con el FILTER leído de app_settings.

═══════════════════════════════════════════════════════════════
CAPA 4 — Banner SyncFreshness 3 estados (PRIORIDAD ALTA)
═══════════════════════════════════════════════════════════════

ARCHIVO: src/components/SyncFreshness.tsx (modificar)

Estados (basados en last sync_logs para la tienda activa):
- 🟢 verde: hay al menos 1 sync con status='success' Y synced_count > 0 en últimas 24h
- 🟡 amarillo: la última hora todas las corridas tienen synced_count=0 OR status='warn'
  → texto: "Sync corriendo pero sin novedades. ¿Sospechás datos viejos? [Auditar paridad]"
  (el botón dispara el modal de Capa 3)
- 🔴 rojo: última sync status='error' O > 1h sin attempt (cron no corrió)
  → texto: "Sync caído. [Reintentar manual]"

Lógica:
const logs = await supabase.from('sync_logs')
  .select('status, synced_count, total_count, created_at, error_message')
  .eq('store_id', activeStoreId)
  .order('created_at', { ascending: false })
  .limit(12);  // 1h de corridas a 5min

const now = Date.now();
const lastAttemptAgeMin = (now - new Date(logs[0].created_at).getTime()) / 60000;
const lastSuccess = logs.find(l => l.status === 'success' && l.synced_count > 0);
const lastSuccessAgeHrs = lastSuccess ? (now - new Date(lastSuccess.created_at).getTime()) / 3600000 : Infinity;
const allZero = logs.every(l => l.synced_count === 0);
const lastError = logs[0].status === 'error';

let color: 'green' | 'yellow' | 'red';
if (lastError || lastAttemptAgeMin > 60) color = 'red';
else if (allZero || lastSuccessAgeHrs > 24) color = 'yellow';
else color = 'green';

Importante: el banner se MUESTRA siempre (no solo en rojo), pero amarillo es
sutil (border-yellow-500 + texto), rojo es prominente (bg-red-500).

═══════════════════════════════════════════════════════════════
CAPA 3 — Botón "Auditar paridad" en /admin (PRIORIDAD ALTA)
═══════════════════════════════════════════════════════════════

ARCHIVO NUEVO: src/lib/dropiAudit.ts

Funciones puras + testables:

import type { SupabaseClient } from '@supabase/supabase-js';

export interface GuardianOrder {
  id: string;
  external_id: string;
  estado: string;
  guia: string;
  transportadora: string;
  nombre: string;
}

export interface DropiOrder {
  id: string;
  status: string;
  guia: string;
  trans: string;
  name: string;
}

export interface Divergence {
  guardianId: string;
  externalId: string;
  nombre: string;
  before: { estado: string; guia: string; trans: string };
  after: { estado: string; guia: string; trans: string };
  action: 'update' | 'cancel_orphan';
}

export async function fetchGuardianNonTerminal(
  supabase: SupabaseClient, storeId: string
): Promise<GuardianOrder[]> {
  const TERMINAL = ['PENDIENTE CONFIRMACION','ENTREGADO','CANCELADO','DEVOLUCION','DEVUELTO','ARCHIVADO_GHOST','ORDEN INDEMNIZADA','RECHAZADO'];
  const { data } = await supabase
    .from('orders')
    .select('id, external_id, estado, guia, transportadora, nombre')
    .eq('store_id', storeId)
    .not('estado', 'in', `(${TERMINAL.map(s => `"${s}"`).join(',')})`)
    .limit(2000);
  return (data || []) as GuardianOrder[];
}

// Llama al endpoint web v2 desde el browser del owner.
// Reqiere session token; lo lee de store_dropi_config.dropi_session_token o
// (preferido) recibirlo como parámetro desde el modal.
export async function fetchDropiSnapshot(
  sessionToken: string, fromDate: string, toDate: string,
  userId: number,  // payload.sub del JWT
): Promise<Map<string, DropiOrder>> {
  const out = new Map<string, DropiOrder>();
  let start = 0;
  const pageSize = 200;
  while (true) {
    const url = `https://api.dropi.ec/api/orders/myorders/v2?` +
      `exportAs=orderByRow&orderBy=id&orderDirection=desc&result_number=${pageSize}&start=${start}` +
      `&textToSearch=&status=null&supplier_id=false&user_id=${userId}` +
      `&from=${fromDate}&until=${toDate}` +
      `&filter_product=undefined&haveIncidenceProcesamiento=false&tag_id=&warranty=false&seller=null` +
      `&filter_date_by=Modified%20Date&invoiced=null`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${sessionToken}` } });
    const data = await r.json();
    if (!Array.isArray(data?.objects) || data.objects.length === 0) break;
    for (const o of data.objects) {
      out.set(String(o.id), {
        id: String(o.id), status: o.status,
        guia: o.shipping_guide || '',
        trans: o.distribution_company?.name || o.shipping_company || '',
        name: ((o.name||'') + ' ' + (o.surname||'')).trim(),
      });
    }
    if (data.objects.length < pageSize) break;
    start += pageSize;
  }
  return out;
}

const ORPHAN_THRESHOLD = 5000000;

function mapDropiStatusToGuardian(s: string): string {
  if (s === 'GENERADA') return 'GUIA_GENERADA';
  return s;
}

export function findDivergences(
  guardian: GuardianOrder[],
  dropi: Map<string, DropiOrder>,
): Divergence[] {
  const out: Divergence[] = [];
  for (const g of guardian) {
    const d = dropi.get(String(g.external_id));
    if (!d) {
      const extNum = Number(g.external_id);
      if (Number.isFinite(extNum) && extNum < ORPHAN_THRESHOLD) {
        out.push({
          guardianId: g.id, externalId: g.external_id, nombre: g.nombre,
          before: { estado: g.estado, guia: g.guia, trans: g.transportadora },
          after:  { estado: 'CANCELADO', guia: g.guia, trans: g.transportadora },
          action: 'cancel_orphan',
        });
      }
      continue;
    }
    const newEstado = mapDropiStatusToGuardian(d.status);
    if (g.estado !== newEstado || (g.guia||'') !== (d.guia||'') || (g.transportadora||'') !== (d.trans||'')) {
      out.push({
        guardianId: g.id, externalId: g.external_id, nombre: g.nombre,
        before: { estado: g.estado, guia: g.guia, trans: g.transportadora },
        after:  { estado: newEstado, guia: d.guia, trans: d.trans },
        action: 'update',
      });
    }
  }
  return out;
}

export async function applyDivergences(
  supabase: SupabaseClient,
  storeId: string,
  divergences: Divergence[],
): Promise<{ applied: number; failed: Divergence[] }> {
  let applied = 0;
  const failed: Divergence[] = [];
  for (const d of divergences) {
    const { error } = await supabase.from('orders')
      .update({
        estado: d.after.estado, guia: d.after.guia, transportadora: d.after.trans,
        last_movement_at: new Date().toISOString(),
      })
      .eq('id', d.guardianId)
      .eq('store_id', storeId);
    if (error) failed.push(d); else applied++;
  }
  return { applied, failed };
}

ARCHIVO NUEVO: src/lib/dropiAudit.test.ts (tests con casos reales del 2026-05-28)

import { describe, it, expect } from 'vitest';
import { findDivergences } from './dropiAudit';

describe('findDivergences', () => {
  it('detecta GENERADA → GUIA_GENERADA con guía nueva', () => {
    const g = [{ id:'x', external_id:'5545005', estado:'PENDIENTE', guia:'', transportadora:'GINTRACOM', nombre:'Ramón' }];
    const d = new Map([['5545005', { id:'5545005', status:'GENERADA', guia:'D001655887', trans:'GINTRACOM', name:'Ramón' }]]);
    const out = findDivergences(g as any, d as any);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('update');
    expect(out[0].after.estado).toBe('GUIA_GENERADA');
    expect(out[0].after.guia).toBe('D001655887');
  });

  it('marca huérfano pre-backfill (id < 5M) como cancel_orphan', () => {
    const g = [{ id:'x', external_id:'3453470', estado:'GUIA_GENERADA', guia:'187204816', transportadora:'SERVIENTREGA', nombre:'Carlos' }];
    const d = new Map();  // no existe en Dropi
    const out = findDivergences(g as any, d as any);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('cancel_orphan');
  });

  it('NO cancela huérfano post-backfill (id >= 5M)', () => {
    const g = [{ id:'x', external_id:'5575133', estado:'PENDIENTE', guia:'', transportadora:'LAARCOURIER', nombre:'Soledad' }];
    const d = new Map();  // no existe (puede ser muy reciente)
    const out = findDivergences(g as any, d as any);
    expect(out).toHaveLength(0);  // skip
  });

  it('idéntico en ambos lados → sin divergencia', () => {
    const g = [{ id:'x', external_id:'5575197', estado:'GUIA_GENERADA', guia:'D001655606', transportadora:'GINTRACOM', nombre:'Diego' }];
    const d = new Map([['5575197', { id:'5575197', status:'GENERADA', guia:'D001655606', trans:'GINTRACOM', name:'Diego' }]]);
    const out = findDivergences(g as any, d as any);
    expect(out).toHaveLength(0);
  });
});

ARCHIVO NUEVO: src/components/admin/DropiAuditModal.tsx
- Props: { open, onClose, storeId, sessionToken, userId }
- Estados: 'idle' | 'scanning' | 'results' | 'applying' | 'done'
- Flujo:
  1. Click "Escanear" → estado 'scanning' → llama fetchGuardian + fetchDropi en paralelo
  2. Calcula divergencias con findDivergences
  3. Estado 'results' → muestra tabla con before/after, filtros por action
  4. Botón "Aplicar N cambios" → confirm → estado 'applying' → applyDivergences
  5. Inserta fila en audit_runs (con la info de la corrida)
  6. Estado 'done' → mensaje "X aplicados, Y fallidos. Ver historial"

ARCHIVO: src/components/tabs/AdminTab.tsx (modificar)
Agregar sección "Paridad con Dropi" (managerOnly):
- Botón "Auditar paridad ahora" → abre el modal
- Tabla con las últimas 5 audit_runs de la tienda activa
- Mostrar last_health_status leyendo de store_dropi_config

═══════════════════════════════════════════════════════════════
CAPA 2 — Self-healing per-pedido
═══════════════════════════════════════════════════════════════

ARCHIVO: src/components/order-detail/OrderDetailPage.tsx (modificar)

const refreshedThisSession = useRef<Set<string>>(new Set());

useEffect(() => {
  if (!order || !order.externalId) return;
  if (refreshedThisSession.current.has(order.externalId)) return;
  const lastMov = order.lastMovementAt || order.createdAt;
  if (!lastMov) return;
  const ageHs = (Date.now() - new Date(lastMov).getTime()) / 3600000;
  const isNonTerminal = !['ENTREGADO','CANCELADO','DEVOLUCION','DEVUELTO'].includes(order.estado);
  if (ageHs > 1 && isNonTerminal) {
    refreshedThisSession.current.add(order.externalId);
    refresh(order.externalId, { silent: true });  // useRefreshOrder con opción silent
  }
}, [order?.externalId]);

ARCHIVO: src/components/CrmCallView.tsx
- Mismo patrón al cambiar `o.externalId`.

ARCHIVO: src/hooks/useRefreshOrder.ts
- Agregar param opcional { silent?: boolean } → suprime el toast de éxito (sí muestra el de error).

═══════════════════════════════════════════════════════════════
ORDEN DE EJECUCIÓN
═══════════════════════════════════════════════════════════════

1. GAP C primero (1 migration, sin código). Test: SELECT * FROM cron.job;
2. GAP A (3 archivos modificados, sin migration). Test: chequear app_settings tras 1 corrida.
3. Capa 4 (banner) — 1 archivo. Test visual.
4. Capa 3 (audit lib + modal + admin) — 3 archivos + tests. Test: correr modal, ver 0 divergencias (porque ya arreglamos todo manualmente ayer).
5. Capa 2 (auto-refresh) — 3 archivos. Test: abrir un pedido con last_movement_at > 1h y verificar que se refresca.

5 commits separados o 1 grande. Conventional commits en español.

Pegame:
- SELECT jobname, schedule FROM cron.job;
- El resultado de la 1ra corrida de dropi-health (verificar last_health_status != 'unknown')
- Screenshot del banner SyncFreshness en estado verde
- npm run test (tests de dropiAudit deben pasar)
```

---

## Resumen para vos

Backend Lovable: **funciona** (cron pasó de 0 a 1785 pedidos en una corrida). Faltan 5 cosas para cerrar el plan, todas en este prompt:

1. **GAP C (urgente)**: registrar `pg_cron.schedule` para health y nightly — sin esto las 2 edge functions nuevas son código muerto.
2. **GAP A (preventivo)**: persistir el winning filter en `app_settings` para que health y reconcile auto-curen también.
3. **Capa 4**: banner 3 estados (sin esto el usuario no ve cuando entra en zombie).
4. **Capa 3**: botón Auditar paridad (replica lo que hicimos a mano ayer).
5. **Capa 2**: auto-refresh per-pedido > 1h.
