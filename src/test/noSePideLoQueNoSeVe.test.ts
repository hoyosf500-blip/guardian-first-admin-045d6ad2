import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: lo que no está en pantalla no se pide; lo que se va a abrir, se
 * pre-carga.
 *
 * ── El pedido del dueño (5-sep-2026) ───────────────────────────────────────
 * «Se demora en cargar los chats, en cargar la huella y en entrar a
 * logística». Medido en el código:
 *
 *  - /logistica entraba en la pestaña Resumen y pagaba igual las RPCs de
 *    ciudades y productos, la RPC del dashboard de transportadoras y la
 *    descarga página por página de TODOS los pedidos del rango para una
 *    columna de flete — nada de eso estaba en pantalla.
 *  - La huella se le pedía a Dropi al abrir cada tarjeta (Dropi tarda, y
 *    devuelve 429 con reintentos de 400/800/1600 ms). Ahora la del pedido
 *    SIGUIENTE se pre-carga mientras se trabaja el actual, y la edge function
 *    la recuerda 10 min.
 *  - El chat hacía tres lecturas a la base EN FILA antes de hablar con
 *    ImporChat, y escribía `orders` en cada apertura aunque nada cambiara (un
 *    evento de realtime para todas las pestañas, por cada chat abierto).
 */

const RAIZ = join(__dirname, '..', '..');
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8');
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

describe('/logistica no paga al entrar lo que solo se ve en otra pestaña', () => {
  const tab = sinComentarios(leer('src/components/tabs/LogisticaTab.tsx'));

  it('el flete por transportadora solo se descarga en la pestaña Transportadoras', () => {
    const i = tab.indexOf('useFleteByCarrier(');
    expect(i).toBeGreaterThan(-1);
    expect(tab.slice(i, i + 200)).toMatch(/activeTab === 'carriers'/);
  });

  it('la RPC logistics_dashboard solo corre en la pestaña Transportadoras', () => {
    expect(tab).toMatch(/'logistics_dashboard'/);
    // El `enabled` de esa query lleva las tres condiciones, en este orden.
    expect(tab).toMatch(/enabled: Boolean\(activeStoreId\) && !compareMode && activeTab === 'carriers'/);
  });

  it('ciudades y productos se piden solo con su pestaña abierta', () => {
    expect(tab).toMatch(/sinCiudades:\s*activeTab !== 'cities'/);
    expect(tab).toMatch(/sinProductos:\s*activeTab !== 'products'/);
    const hook = sinComentarios(leer('src/hooks/useLogisticsStats.ts'));
    expect(hook).toMatch(/enabled: detalleReady && !ciudadKey && !opts\?\.sinCiudades/);
    expect(hook).toMatch(/enabled: detalleReady && !opts\?\.sinProductos/);
  });
});

describe('la huella del pedido siguiente se pre-carga', () => {
  it('FingerprintBadge exporta la pre-carga y la tarjeta la usa con el pedido siguiente', () => {
    const badge = sinComentarios(leer('src/components/FingerprintBadge.tsx'));
    expect(badge).toMatch(/export function precargarHuella\(/);
    expect(badge, 'la pre-carga tiene que respetar el cortacircuitos de la base').toMatch(/if \(frenoAbierto\(\)\) return;/);
    const card = sinComentarios(leer('src/components/CrmCallView.tsx'));
    expect(card).toMatch(/items\[derivedIdx \+ 1\]\?\.phone/);
    expect(card).toMatch(/precargarHuella\(siguientePhone, activeStoreId\)/);
  });

  it('la edge function recuerda la huella 10 min y contesta el ping', () => {
    const edge = sinComentarios(leer('supabase/functions/dropi-fingerprint/index.ts'));
    expect(edge).toMatch(/^const VERSION = "dropi-fingerprint /m);
    expect(edge).toMatch(/respuestaPing\(\s*req\s*,\s*VERSION/);
    expect(edge).toMatch(/const cacheHuella = new Map/);
    expect(edge).toMatch(/CACHE_HUELLA_MS = 10 \* 60_000/);
    // Se cachea el éxito y el "cliente nuevo" (dos llamadas); el error no.
    expect(edge).toMatch(/const recordar = \(cuerpo: string\)/);
    expect((edge.match(/\brecordar\(cuerpo/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(edge).not.toMatch(/recordar\([^)]*error/);
  });
});

describe('abrir un chat no cuesta tres esperas ni una escritura de más', () => {
  const edge = sinComentarios(leer('supabase/functions/importchat-chat/index.ts'));

  it('membresía, credenciales y pedido salen juntas', () => {
    const i = edge.indexOf('await Promise.all([');
    expect(i).toBeGreaterThan(-1);
    const bloque = edge.slice(i, i + 900);
    expect(bloque).toMatch(/store_members/);
    expect(bloque).toMatch(/store_importchat_config/);
    expect(bloque).toMatch(/from\("orders"\)/);
  });

  it('y el 403 de no-miembro sigue saliendo ANTES que cualquier otra respuesta', () => {
    const iAll = edge.indexOf('await Promise.all([');
    const i403 = edge.indexOf('no sos miembro de esa tienda', iAll);
    const i409 = edge.indexOf('sin_config: true', iAll);
    expect(i403).toBeGreaterThan(-1);
    expect(i403).toBeLessThan(i409);
  });

  it('solo escribe orders si la marca cambió', () => {
    expect(edge).toMatch(/const mismaMarca = /);
    expect(edge).toMatch(/if \(!mismaMarca\(yaTiene\.chat_entrante_at, iso\)\)/);
    expect(edge).toMatch(/chat_entrante_at, chat_saliente_at, chat_saliente_tipo/);
  });
});
