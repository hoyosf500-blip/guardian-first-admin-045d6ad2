import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * FUGA ENTRE TIENDAS — guardia estática.
 *
 * Guardian es multi-tienda: los pedidos de un dueño NO pueden aparecerle a otro.
 * La defensa de fondo es RLS (`store_id` + membresía), pero RLS solo acota a las
 * tiendas de las que el usuario ES miembro: una persona con DOS tiendas ve las
 * dos mezcladas si la consulta del front no filtra por la tienda ACTIVA. Eso ya
 * pasó (el badge de wallet mostraba la corrida de cualquier tienda) y no lo
 * caza ningún test de UI.
 *
 * Esta prueba exige que toda consulta de LISTA contra una tabla con `store_id`
 * mencione `store_id` en la misma sentencia. Se exceptúan:
 *   - las consultas por identificador único (`.eq('id', ...)`, `order_id`, etc.),
 *     donde RLS ya decide y el store_id es redundante;
 *   - las excepciones documentadas en ALLOWLIST, cada una con su motivo.
 *
 * Si agregás una consulta nueva y esta prueba falla: agregá el filtro, no la
 * excepción.
 */

/** Tablas con columna `store_id` consultadas desde el front. */
const TABLAS_POR_TIENDA = [
  'orders', 'touchpoints', 'order_results', 'notes', 'dropi_wallet_movements',
  'daily_reports', 'tc_debt_snapshots', 'shopify_pushed_orders',
  'shopify_product_dropi_map', 'shopify_manual_marks',
  'personal_card_movements', 'order_status_history', 'order_labels',
  'operator_daily_reports', 'operator_activity_daily',
  'nightly_reconcile_results', 'monthly_business_inputs', 'monthly_ad_spend',
  'store_dropi_config', 'audit_runs', 'sync_logs', 'store_rendiciones',
  'store_ad_spend_daily', 'cfo_monthly_retrospective',
];

/** Filtros por fila única: RLS ya alcanza, el store_id sería redundante. */
const FILTRO_POR_ID =
  /\.eq\(\s*['"](id|order_id|external_id|conversation_id|user_id|store_id|rendicion_id)['"]/;

/**
 * Excepciones vivas. Formato `archivo::tabla`. CADA UNA lleva motivo — una
 * excepción sin motivo es una fuga esperando a que alguien la copie.
 */
const ALLOWLIST: Record<string, string> = {
  // Módulo CFO: pantalla del dueño, gateada a admin global + una sola tienda CO.
  // RLS admin-only en la base es el respaldo real.
  'src/hooks/useCfoMonthlyInputs.ts::monthly_business_inputs': 'CFO admin-only, CO',
  'src/hooks/useMonthlyAdSpend.ts::monthly_ad_spend': 'CFO admin-only, CO',
  'src/hooks/useTcDebtSnapshots.ts::tc_debt_snapshots': 'CFO admin-only, CO',
  'src/hooks/usePersonalCardMovements.ts::personal_card_movements': 'CFO admin-only, tarjeta personal del dueño',
  // Escrituras de UNA fila propia del usuario: el store_id lo pone el objeto
  // insertado (ver el propio insert), no un .eq.
  'src/hooks/useRecordGestion.ts::touchpoints': 'insert con store_id en el payload',
  'src/components/AperturaWizard.tsx::daily_reports': 'componente en desuso (OpeningReportGate murió); insert de una fila propia',
  // Update dirigido por columnas distintas de id, ya acotado por RLS.
  'src/components/CallView.tsx::orders': 'update de validación sobre el pedido en pantalla',
  'src/components/confirmar/DropiSyncFailuresPanel.tsx::orders': 'select con .in(id, ...) de pedidos ya visibles',
  'src/components/confirmar/OrderEditorDialog.tsx::order_results': 'update por id con cast de tipos (el .eq va en el cast)',
  'src/contexts/OrderContext.tsx::order_results': 'updates por id con cast de tipos',
};

const RAIZ = 'src';

function archivos(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivos(p, acc);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec)\./.test(p)) acc.push(p);
  }
  return acc;
}

function hallazgos(): string[] {
  const malos: string[] = [];
  for (const f of archivos(RAIZ)) {
    const src = readFileSync(f, 'utf8');
    const re = /\.from\(\s*['"]([a-z_]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tabla = m[1];
      if (!TABLAS_POR_TIENDA.includes(tabla)) continue;
      const fin = src.indexOf(';', m.index);
      // La ventana pasa la sentencia: el filtro por tienda a veces se encadena
      // después (`let q = supabase.from(...); if (storeId) q = q.eq('store_id',…)`).
      const sentencia = src.slice(m.index, (fin < 0 ? src.length : fin) + 400);
      if (/store_id/.test(sentencia) || FILTRO_POR_ID.test(sentencia)) continue;
      const clave = `${f.split('\\').join('/')}::${tabla}`;
      if (ALLOWLIST[clave]) continue;
      const linea = src.slice(0, m.index).split('\n').length;
      malos.push(`${clave} (línea ${linea})`);
    }
  }
  return malos;
}

describe('aislamiento entre tiendas — consultas del front', () => {
  it('toda consulta de lista a una tabla con store_id filtra por store_id', () => {
    expect(hallazgos()).toEqual([]);
  });

  it('cada excepción de la allowlist tiene motivo escrito', () => {
    for (const [clave, motivo] of Object.entries(ALLOWLIST)) {
      expect(motivo.length, `sin motivo: ${clave}`).toBeGreaterThan(10);
    }
  });

  it('la allowlist no crece sin que alguien lo note', () => {
    // Techo deliberado: subirlo es una decisión consciente, no un descuido.
    expect(Object.keys(ALLOWLIST).length).toBeLessThanOrEqual(11);
  });
});
