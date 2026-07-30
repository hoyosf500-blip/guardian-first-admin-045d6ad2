/**
 * Lógica PURA del panel de plataforma (`/plataforma`): estado de suscripción,
 * salud por tienda y filtrado. Sin red ni DOM — se testea con datos reales de
 * la RPC `platform_stores_overview`.
 *
 * Criterio de honestidad (el mismo del resto del CRM): cuando NO hay dato, se
 * dice "sin datos", no se pinta un cero ni un ✅. Un panel de administración que
 * muestra verde por falta de información es peor que no tenerlo.
 */

export type PlanKey = 'prueba' | 'pro' | 'cortesia';

export const PLAN_LABEL: Record<PlanKey, string> = {
  prueba: 'Prueba',
  pro: 'Pro',
  cortesia: 'Cortesía',
};

/** Días de antelación con que se avisa el vencimiento. */
export const AVISO_VENCIMIENTO_DIAS = 7;

/** Fila cruda de `platform_stores_overview`. */
export interface PlatformStore {
  store_id: string;
  store_name: string;
  country_code: string;
  status: string;
  created_at: string;
  owner_name: string;
  owner_email: string;
  members: number;
  orders_30d: number;
  last_order_at: string | null;
  has_dropi_key: boolean;
  last_sync_at: string | null;
  last_sync_ok: boolean | null;
  wallet_sync_at: string | null;
  wallet_sync_ok: boolean | null;
  app_versions: string;
  plan: string;
  paid_until: string | null;
  sub_notes: string | null;
}

export interface SubscriptionState {
  label: string;
  detail: string;
  /** Clases de color del chip (tokens semánticos del CRM). */
  tone: string;
  /** Días que faltan para vencer (negativo = vencida). null si no vence. */
  diasRestantes: number | null;
  vencida: boolean;
  porVencer: boolean;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/** Días calendario entre hoy y una fecha `YYYY-MM-DD` (positivo = futuro). */
function diasHasta(fechaISO: string, ahoraMs: number): number {
  const [y, m, d] = fechaISO.slice(0, 10).split('-').map(Number);
  const objetivo = Date.UTC(y, (m || 1) - 1, d || 1);
  const hoy = new Date(ahoraMs);
  const hoyUTC = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  return Math.round((objetivo - hoyUTC) / DIA_MS);
}

/**
 * Estado de la suscripción de una tienda. Sin `paid_until` la tienda NO vence
 * (cortesía / indefinida) — se dice explícitamente en vez de inventar un plazo.
 */
export function subscriptionState(s: PlatformStore, nowMs: number = Date.now()): SubscriptionState {
  const plan = (s.plan as PlanKey) || 'prueba';
  const nombre = PLAN_LABEL[plan] ?? s.plan;

  if (!s.paid_until) {
    return {
      label: `${nombre} · sin vencimiento`,
      detail: 'Esta tienda no tiene fecha de vencimiento cargada.',
      tone: 'border-border bg-muted/40 text-muted-foreground',
      diasRestantes: null,
      vencida: false,
      porVencer: false,
    };
  }

  const dias = diasHasta(s.paid_until, nowMs);
  if (dias < 0) {
    return {
      label: `${nombre} · vencido hace ${Math.abs(dias)}d`,
      detail: `Venció el ${s.paid_until}.`,
      tone: 'border-danger/40 bg-danger/15 text-danger',
      diasRestantes: dias,
      vencida: true,
      porVencer: false,
    };
  }
  if (dias <= AVISO_VENCIMIENTO_DIAS) {
    return {
      label: `${nombre} · vence en ${dias}d`,
      detail: `Vence el ${s.paid_until}.`,
      tone: 'border-warning/40 bg-warning/15 text-warning',
      diasRestantes: dias,
      vencida: false,
      porVencer: true,
    };
  }
  return {
    label: `${nombre} · al día`,
    detail: `Pago hasta el ${s.paid_until} (${dias} días).`,
    tone: 'border-success/40 bg-success/15 text-success',
    diasRestantes: dias,
    vencida: false,
    porVencer: false,
  };
}

export interface StoreHealth {
  syncOk: boolean;
  syncLabel: string;
  walletOk: boolean;
  walletLabel: string;
  /** ¿Algo requiere atención del admin? (alimenta el filtro "solo problemas") */
  problema: boolean;
}

/** "hace 8 min" / "hace 3 h" / "hace 2 d" — o null si no hay marca. */
function haceCuanto(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((nowMs - t) / 60000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/**
 * Salud operativa de la tienda. Una tienda SIN credenciales Dropi no está
 * "rota": está sin configurar — y se distingue, porque la acción del admin es
 * distinta (ayudar a configurar vs revisar un token vencido).
 */
export function storeHealth(s: PlatformStore, nowMs: number = Date.now()): StoreHealth {
  if (!s.has_dropi_key) {
    return {
      syncOk: false,
      syncLabel: 'sin configurar',
      walletOk: false,
      walletLabel: 'sin configurar',
      problema: true,
    };
  }

  const syncHace = haceCuanto(s.last_sync_at, nowMs);
  // Sin ninguna corrida registrada NO es "ok": es que nunca sincronizó.
  const syncOk = s.last_sync_ok === true && syncHace !== null;
  const walletHace = haceCuanto(s.wallet_sync_at, nowMs);
  const walletOk = s.wallet_sync_ok === true && walletHace !== null;

  return {
    syncOk,
    syncLabel: syncHace ?? 'nunca',
    walletOk,
    walletLabel: walletHace ?? 'nunca',
    problema: !syncOk || !walletOk,
  };
}

/**
 * Filtrado del panel: texto libre (tienda / dueño / correo) y el toggle
 * "solo con problemas" (salud rota, suscripción vencida o por vencer, o
 * tienda suspendida).
 */
export function filterStores(
  rows: PlatformStore[],
  query: string,
  soloProblemas: boolean,
  nowMs: number = Date.now(),
): PlatformStore[] {
  const q = query.trim().toLowerCase();
  return rows.filter((s) => {
    if (q) {
      const heno = `${s.store_name} ${s.owner_name} ${s.owner_email}`.toLowerCase();
      if (!heno.includes(q)) return false;
    }
    if (soloProblemas) {
      const sub = subscriptionState(s, nowMs);
      const salud = storeHealth(s, nowMs);
      if (!salud.problema && !sub.vencida && !sub.porVencer && s.status === 'active') return false;
    }
    return true;
  });
}
