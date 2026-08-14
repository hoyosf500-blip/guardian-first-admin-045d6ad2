import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Guardias multi-tienda de las edge functions (auditoría 2026-08-13).
 *
 * Las edge functions son Deno y no pasan por tsc/vitest, así que estos
 * invariantes se vigilan leyendo el FUENTE (mismo patrón que
 * edgeConstantesFantasma.test.ts). Lo que se vigila acá salió de bugs REALES
 * confirmados por verificación adversarial:
 *
 *  - Ternarios de país de DOS ramas (`=== "EC" ? x : y`) mandaban a toda tienda
 *    no-EC a la rama de Colombia: catálogo de ciudades CO para destinos GT (y el
 *    self-heal CONTAMINABA el catálogo CO con ciudades GT), país "COLOMBIA" en
 *    los creates, quetzales redondeados a entero.
 *  - El webhook buscaba pedidos por external_id GLOBAL: los ids de Dropi son por
 *    plataforma de país y pueden chocar entre tiendas → pisaba pedidos ajenos.
 *  - El fallback de Origin era rushmira.com (la tienda del dueño de la
 *    plataforma) para CUALQUIER tienda de terceros.
 *  - La rama "huérfano <5M → cancelar directo" del nightly cancelaba TODOS los
 *    pedidos de una cuenta Dropi joven (ids bajos).
 *
 * Si una de estas pruebas falla, alguien reintrodujo el patrón viejo.
 */

const RAIZ = 'supabase/functions';
const FN = (p: string) => readFileSync(join(RAIZ, p), 'utf8');

function archivosTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivosTs(p, out);
    else if (e.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('multi-tienda en las edge functions (auditoría 2026-08-13)', () => {
  it('el nombre de país Dropi sale del mapeo central, no de ternarios EC/CO', () => {
    for (const f of [
      '_shared/dropiCityCatalog.ts',
      'dropi-sync-city-catalog/index.ts',
      'shopify-push-dropi/index.ts',
    ]) {
      const src = FN(f);
      expect(src, `${f} debe usar dropiCountryNameFor (mapeo central)`).toMatch(/dropiCountryNameFor/);
      expect(src, `${f} reintrodujo el ternario "EC" ? ECUADOR : COLOMBIA`)
        .not.toMatch(/"EC"\s*\?\s*"ECUADOR"\s*:\s*"COLOMBIA"/);
    }
  });

  it('tampoco existe el ternario INVERSO (nombre → código) en ninguna función', () => {
    // La revisión adversarial 2026-08-13 cazó este ángulo muerto: el guard de
    // arriba prohibía código→nombre, pero createOrderViaWeb re-derivaba el
    // código DESDE el nombre (`=== "ECUADOR" ? "EC" : "CO"`) y "GUATEMALA"
    // caía a Colombia igual. El código ISO viaja explícito, nunca se deriva.
    const conInverso = archivosTs(RAIZ)
      .filter((f) => /"ECUADOR"\s*\?\s*"EC"\s*:\s*"CO"/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/'));
    expect(conInverso).toEqual([]);
  });

  it('el mapeo central existe, es fail-closed y conoce GT', () => {
    const src = FN('_shared/dropiCountry.ts');
    expect(src).toMatch(/GT:\s*"GUATEMALA"/);
    expect(src).toMatch(/DROPI_COUNTRY_NAMES\[cc\]\s*\?\?\s*null/); // país sin mapeo → null, nunca Colombia
  });

  it('el redondeo de plata usa paisUsaCentavos (EC y GT con centavos), no `=== "EC"`', () => {
    for (const f of ['dropi-change-carrier/index.ts', 'shopify-push-dropi/index.ts']) {
      const src = FN(f);
      expect(src, `${f} debe redondear con paisUsaCentavos`).toMatch(/paisUsaCentavos/);
      expect(src, `${f} reintrodujo el redondeo solo-EC`)
        .not.toMatch(/countryCode === "EC" \? 100 : 1|countryCode === "EC" \? Math\.round\(x \* 100\)/);
    }
  });

  it('la huella y shopify-push conocen el teléfono de Guatemala (502, CON guard de longitud)', () => {
    // El guard de 11 dígitos importa: los celulares GT locales son 8 dígitos y
    // pueden ARRANCAR en "502..." — un replace sin guard los amputaba
    // (revisión adversarial 2026-08-13).
    expect(FN('dropi-fingerprint/index.ts'))
      .toMatch(/stripped\.length === 11 && stripped\.startsWith\("502"\)/);
    expect(FN('shopify-push-dropi/index.ts'))
      .toMatch(/"GT" && d\.length === 11 && d\.startsWith\("502"\)/);
  });

  it('nightly: la cancelación directa <5M queda SOLO para las tiendas legacy Rushmira', () => {
    const src = FN('dropi-nightly-reconcile/index.ts');
    expect(src).toMatch(/LEGACY_BACKFILL_STORES/);
    expect(src, 'la rama de cancelación directa debe exigir tienda legacy')
      .toMatch(/extNum < ORPHAN_THRESHOLD && LEGACY_BACKFILL_STORES\.has\(storeId\)/);
  });

  it('cron: piso de presupuesto por tienda + rotación con cursor persistido', () => {
    const src = FN('dropi-cron/index.ts');
    expect(src).toMatch(/MIN_STORE_BUDGET_MS/);
    expect(src).toMatch(/dropi_cron_store_cursor/);
    expect(src, 'el loop debe iterar la tanda rotada, no todas las tiendas')
      .toMatch(/for \(const cfg of runConfigs\)/);
    // El cursor es POSICIONAL: sin orden totalmente determinista (tiebreak por
    // store_id) la rotación saltea tiendas (revisión adversarial 2026-08-13).
    expect(src, 'el sort de tiendas necesita tiebreak determinista por store_id')
      .toMatch(/localeCompare\(String\(b\.store_id\)\)/);
  });

  it('webhook: el pedido se busca por external_id + store_id (nunca global)', () => {
    const src = FN('dropi-webhook/index.ts');
    expect(src).toMatch(/\.eq\("external_id", externalId\)\s*\.eq\("store_id", storeId\)/);
    // Un insert descartado por ignoreDuplicates no puede reportarse "inserted".
    expect(src).toMatch(/insert_ignored_conflict/);
  });

  it('ninguna edge function usa rushmira.com como fallback', () => {
    const conRushmira = archivosTs(RAIZ)
      .filter((f) => readFileSync(f, 'utf8').includes('https://rushmira.com'))
      .map((f) => f.replace(/\\/g, '/'));
    expect(conRushmira).toEqual([]);
  });

  it('dropi-web no loguea la ficha del cliente en llamadas exitosas', () => {
    const src = FN('_shared/dropiWebQuote.ts');
    // En éxito se loguea solo el largo; el cuerpo completo queda para los fallos.
    expect(src).toMatch(/\[ok, \$\{text\.length\} chars\]/);
  });

  it('toda llamada a /integrations/orders/myorders manda el header Origin', () => {
    // Sin Origin, Dropi contesta 401 {"message":"Access denied", ..., "ip":"x"}
    // ANTES de mirar la api_key. Como el cuerpo trae la IP, parece un bloqueo
    // por dirección y se diagnostica mal. Medido el 2026-08-13: con la MISMA
    // clave de Colombia, dropi-snapshot (con Origin) trajo 2.450 pedidos y
    // dropi-verify-credentials (sin Origin) dio 401 — y por eso el asistente le
    // decía "tu API Key no es válida" a cada dueño nuevo que tenía la correcta.
    // Se exige `fetch(` además del endpoint: `_shared/dropiOrderMapper.ts` solo
    // NOMBRA la URL en su comentario de cabecera y no llama a nadie — marcarlo
    // sería el mismo falso positivo de siempre, señalar al archivo mejor
    // documentado. Y `Origin:` con dos puntos, para no contar la palabra suelta
    // dentro de un comentario.
    const sinOrigin = archivosTs(RAIZ)
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return src.includes('/integrations/orders/myorders')
          && src.includes('fetch(')
          && !/Origin["']?\s*:/.test(src);
      })
      .map((f) => f.replace(/\\/g, '/'));
    expect(sinOrigin).toEqual([]);
  });
});
