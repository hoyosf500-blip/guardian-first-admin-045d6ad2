import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — quien pregunta por una RPC con scope SERVER-SIDE espera a que
 * el servidor confirme la tienda.
 *
 * `operator_productivity_stats`, `operator_activity_stats`, `operator_today_tasa`,
 * `get_daily_operator_stats` y las `admin_*_range` resuelven su tienda con
 * `_resolve_scope_store()` → `profiles.active_store_id`, que StoreContext
 * actualiza con un UPDATE asíncrono al cambiar de tienda. Preguntar antes de
 * que aterrice devuelve los números de la tienda ANTERIOR bajo el nombre de
 * la nueva — y mezclar empresas está PROHIBIDO en esta operación.
 *
 * `scopeSynced` no alcanzaba: arrancaba en true y nadie lo bajaba. Desde el
 * 4-sep-2026 existe `scopeStoreId` (null mientras viaja el UPDATE) y cada
 * consumidor lo espera. Esta prueba exige que siga siendo así.
 */
const SRC = join(process.cwd(), 'src');
const leer = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

describe('⛔ el scope del servidor se espera', () => {
  it('StoreContext expone scopeStoreId y lo baja SINCRÓNICAMENTE al cambiar de tienda', () => {
    const src = sinComentarios(leer('contexts/StoreContext.tsx'));
    expect(src).toMatch(/scopeStoreId:\s*string \| null/);
    const iSet = src.indexOf('const setActiveStoreId = useCallback');
    const cuerpo = src.slice(iSet, iSet + 900);
    expect(cuerpo, 'setActiveStoreId no baja scopeStoreId antes de disparar el UPDATE').toMatch(/setScopeStoreId\(null\)/);
    const iSync = cuerpo.indexOf('sincronizarScope(id)');
    const iNull = cuerpo.indexOf('setScopeStoreId(null)');
    expect(iNull).toBeGreaterThan(-1);
    expect(iNull, 'se baja DESPUÉS de disparar el sync: la ventana sigue abierta').toBeLessThan(iSync);
  });

  it.each([
    ['hooks/useLiveTeam.ts', 'operator_productivity_stats'],
    ['components/TasaMetaBanner.tsx', 'operator_today_tasa'],
    ['components/tabs/DashboardTab.tsx', 'get_daily_operator_stats'],
    ['components/admin/DailyReportsView.tsx', 'admin_daily_reports_range'],
    ['hooks/useSegAsignaciones.ts', 'operator_activity_stats'],
  ])('%s espera scopeStoreId antes de llamar a %s', (rel, rpc) => {
    const src = sinComentarios(leer(rel));
    expect(src, `${rel} ya no llama a ${rpc}`).toContain(rpc);
    expect(src, `${rel} pregunta sin esperar el scope del servidor`).toMatch(/scopeStoreId|scopeOkRef/);
  });

  it('ProductivityDashboard sigue fijando el scope antes de sus RPCs', () => {
    const src = sinComentarios(leer('components/admin/ProductivityDashboard.tsx'));
    expect(src).toMatch(/set_active_store/);
    expect(src).toMatch(/scopeStoreRef/);
  });

  it('el canal de chat no cae a ImporChat fijo ni cachea el fallo', () => {
    const src = sinComentarios(leer('lib/canalChat.ts'));
    const iCatch = src.indexOf('} catch (e) {');
    const cuerpo = src.slice(iCatch, iCatch + 400);
    expect(cuerpo).toMatch(/cache\.delete\(storeId\)/);
    expect(cuerpo).toMatch(/return porPais\(countryCode\)/);
    expect(cuerpo).not.toMatch(/return 'importchat'/);
  });

  it('la moneda y el rastreo se fijan en el render del provider, no solo en un efecto', () => {
    const src = sinComentarios(leer('contexts/StoreContext.tsx'));
    const iActive = src.indexOf('const activeStore = stores.find');
    const iEffect = src.indexOf('useEffect', iActive);
    const entre = src.slice(iActive, iEffect);
    expect(entre).toMatch(/setCurrencyCountry\(activeStore\?\.country_code\)/);
    expect(entre).toMatch(/setTrackingCountry\(activeStore\?\.country_code\)/);
  });
});
