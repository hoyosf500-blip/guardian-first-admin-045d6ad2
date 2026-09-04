import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — las banderas de honestidad se LEEN, no solo se calculan.
 *
 * Patrón encontrado el 4-sep-2026 en ocho lugares: el hook calculaba bien
 * `error` / `cargado` / `ok`, y el componente no lo destructuraba. El
 * resultado era siempre el mismo: un cero con cara de dato medido —"Equipo hoy
 * 0 · 0 · 0", "Nadie quedó sin respuesta 🎉", "Avisos sin trabajar: 0" en
 * verde, "Todo al día ✓"— sobre una consulta caída. Es la clase de error que
 * este proyecto ya pagó con 39 clientes esperando y una bandeja celebrando.
 *
 * Cada caso de abajo es un consumidor que HOY lee su bandera. Si alguien la
 * vuelve a soltar, esto se pone en rojo.
 */
const SRC = join(process.cwd(), 'src');
const leer = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

describe('⛔ las banderas de honestidad se leen', () => {
  it('CounterBar no pinta "Equipo hoy 0 · 0 · 0" sin una lectura buena', () => {
    const src = sinComentarios(leer('components/CounterBar.tsx'));
    expect(src).toMatch(/counterCargado/);
    // Y la usa para pintar, no solo la destructura.
    expect(src).toMatch(/counterCargado\s*\?/);
  });

  it('la bandeja no celebra un cero sobre la canasta que no se pudo leer', () => {
    const hook = sinComentarios(leer('hooks/useInboxEsperando.ts'));
    expect(hook, 'el Snapshot perdió deudaError').toMatch(/deudaError:\s*Boolean\(sinEntrante\.error\)/);
    const page = sinComentarios(leer('pages/InboxPage.tsx'));
    expect(page).toMatch(/deudaError/);
    // El 🎉 de "Nadie quedó sin respuesta" no puede salir con deudaError.
    const iFiesta = page.indexOf('Nadie quedó sin respuesta');
    const guardia = page.slice(Math.max(0, iFiesta - 1200), iFiesta);
    expect(guardia, 'el cartel de "nadie quedó sin respuesta" no mira deudaError').toMatch(/deudaError/);
  });

  it('el banner de "todo al día" no felicita con Novedades sin leer', () => {
    const src = sinComentarios(leer('components/SiguienteColaBanner.tsx'));
    expect(src).toMatch(/novedadesError/);
    expect(src).toMatch(/novedadesMedidas/);
  });

  it('la tasa del día lee el error y espera a que el servidor confirme la tienda', () => {
    const src = sinComentarios(leer('components/TasaMetaBanner.tsx'));
    expect(src).toMatch(/\{\s*data:\s*rows,\s*error\s*\}/);
    expect(src).toMatch(/scopeStoreId/);
  });

  it('las tarjetas del equipo pintan "—" cuando evitables / avisos / mezcla no se leyeron', () => {
    const vm = sinComentarios(leer('lib/advisorCardVM.ts'));
    expect(vm).toMatch(/scoresOk === false \? null/);
    expect(vm).toMatch(/inactivityOk === false \? null/);
    const dash = sinComentarios(leer('components/admin/ProductivityDashboard.tsx'));
    expect(dash).toMatch(/scoresOk:/);
    expect(dash).toMatch(/inactivityOk,/);
    expect(dash).toMatch(/mezclaOk:/);
  });

  it('la frescura del sync dice cuando NO pudo leer, en vez de desaparecer', () => {
    const src = sinComentarios(leer('components/SyncFreshness.tsx'));
    expect(src).toMatch(/leerFallo/);
    expect(src).not.toMatch(/if \(!activeStoreId \|\| logs\.length === 0\) return null/);
  });

  it('los nombres de asesoras no se cachean vacíos por un error', () => {
    const src = sinComentarios(leer('hooks/useOperatorNames.ts'));
    expect(src).toMatch(/\{\s*data,\s*error\s*\}/);
    expect(src).toMatch(/if \(error\)[\s\S]{0,200}inflight = null/);
  });

  it('las alertas de cambio no guardan 0/0/0 como línea base sobre un conteo caído', () => {
    const src = sinComentarios(leer('hooks/useChangeAlerts.ts'));
    const iGuard = src.indexOf('novRes.error || devRes.error || ofiRes.error');
    const iBase = src.indexOf('saveLastSeen(storeId, lastSeen.current)');
    expect(iGuard).toBeGreaterThan(-1);
    expect(iGuard, 'la línea base se guarda antes de mirar los errores').toBeLessThan(iBase);
  });

  it('el cierre firmado no persiste una tasa de 0% que no se midió', () => {
    const src = sinComentarios(leer('components/tabs/DashboardTab.tsx'));
    expect(src).not.toMatch(/tasa_confirmacion:\s*cierreDiaPct\s*\?\?\s*0/);
  });

  // ⛔ 4-sep-2026, medido en Ecuador sobre agosto. `useWalletMovements`
  // aplica Tipo y Categoría a la TABLA pero llama a `wallet_summary(p_from,
  // p_to)` SIN ellos — la función desplegada ni los acepta (p_tipo → PGRST202).
  // Con "Tipo: Salida" puesto la tabla mostraba 276 movimientos y las tarjetas
  // seguían diciendo $12.607,01 de entradas y 943 movimientos. Peor: el KPI
  // "Movimientos" decía 943 tres centímetros encima de una línea que decía 276.
  it('los KPIs de Billetera respetan Tipo y Categoría, o avisan que no', () => {
    const hook = sinComentarios(leer('hooks/useWalletMovements.ts'));
    expect(hook, 'los agregados volvieron a ignorar los filtros de la pantalla')
      .toMatch(/rpc\(.wallet_summary_filtrado./);
    expect(hook).toMatch(/p_tipo: tipo === 'ALL' \? null : tipo/);
    expect(hook).toMatch(/p_categoria: categoria === 'ALL' \? null : categoria/);
    // Respaldo: sin la función aplicada NO se cae, pero tampoco se miente.
    expect(hook, 'sin respaldo, publicar antes que el SQL deja la Billetera en error')
      .toMatch(/PGRST202/);
    expect(hook).toMatch(/agregadosFiltrados = false/);

    const src = sinComentarios(leer('components/logistics/BilleteraTab.tsx'));
    expect(src, 'la pantalla dejó de saber que sus cifras no miran el filtro')
      .toMatch(/agregadosFiltrados === false/);
    expect(src, 'las tarjetas de plata volvieron a callarse el rango que miden')
      .toMatch(/hint=\{notaRango\}/);
    // Y el conteo sale de la consulta YA filtrada, no del RPC.
    expect(src, 'el KPI "Movimientos" volvió a contradecir a la línea de abajo')
      .toMatch(/label="Movimientos"[\s\S]{0,160}movQ\.data\?\.total\s*\?\?/);
    expect(src).not.toMatch(/label="Movimientos"[\s\S]{0,160}countTotal/);
  });
});
