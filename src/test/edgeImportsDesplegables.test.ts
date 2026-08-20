import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Guardián: una edge function no puede depender, para DESPLEGARSE, de un CDN
 * que el bundler no permita (20-ago-2026).
 *
 * Qué pasó: `dropi-wallet-sync` importaba SheetJS de
 * `https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs`. Funcionaba en runtime
 * —la versión desplegada seguía sincronizando la billetera— hasta que el
 * bundler del deploy empezó a rechazar ese host ("Cannot import from
 * cdn.sheetjs.com:443"). La función quedó CONGELADA: ningún cambio, ni una
 * corrección urgente, se podía subir. Y el síntoma no aparece hasta que alguien
 * necesita desplegar, que es justo el peor momento para descubrirlo.
 *
 * La defensa no es "acordarse": es que el código de terceros que el bundler no
 * sabe bajar viva EN EL REPO (`_shared/vendor/`), donde el deploy no toca la red.
 *
 * `esm.sh` queda permitido a propósito — es el host que ya usan todas las
 * funciones para `@supabase/supabase-js` y el bundler lo acepta. Si algún día
 * también lo rechaza, se agrega acá y se vendoriza igual.
 */

const RAIZ = 'supabase/functions';

/** Hosts que el bundler del deploy RECHAZA. Agregar el que aparezca. */
const HOSTS_BLOQUEADOS = ['cdn.sheetjs.com'];

function archivosDeFuente(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      // vendor/ es justamente el código de terceros ya bajado: no se escanea
      // (es 1 MB de librería y no importa nada por red).
      if (e !== 'vendor') archivosDeFuente(p, out);
    } else if (e.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('las edge functions se pueden desplegar (imports)', () => {
  it('ninguna importa desde un host que el bundler rechaza', () => {
    const archivos = archivosDeFuente(RAIZ);
    // Anti-pase-vacío: si el descubrimiento se rompe, el test no puede pasar
    // por no haber mirado nada.
    expect(archivos.length).toBeGreaterThan(30);

    const culpables: string[] = [];
    let vioAlgunImport = false;
    for (const f of archivos) {
      const src = readFileSync(f, 'utf8');
      if (/^\s*import\s/m.test(src)) vioAlgunImport = true;
      for (const host of HOSTS_BLOQUEADOS) {
        if (src.includes(`from "https://${host}`) || src.includes(`from 'https://${host}`)) {
          culpables.push(`${f.replace(/\\/g, '/')} → ${host}`);
        }
      }
    }
    // Segunda prueba de que el escaneo sirve: los archivos leídos SÍ tienen
    // imports (si el regex o la lectura fallaran, el resultado sería vacío por
    // el motivo equivocado).
    expect(vioAlgunImport).toBe(true);
    expect(
      culpables,
      'vendorizar en supabase/functions/_shared/vendor/ — un import de este host CONGELA el deploy de la función',
    ).toEqual([]);
  });

  it('el SheetJS vendorizado está presente y es la build real', () => {
    const p = join(RAIZ, '_shared/vendor/xlsx-0.20.3.mjs');
    const src = readFileSync(p, 'utf8');
    // Sin esto, un borrado accidental del vendor rompería el deploy de la
    // billetera y el otro test seguiría en verde (no habría import prohibido).
    expect(statSync(p).size).toBeGreaterThan(500_000);
    expect(src).toContain("XLSX.version = '0.20.3'");
    // La API que el parser de la billetera realmente usa.
    expect(src).toContain('sheet_to_json');
  });

  it('dropi-wallet-sync importa el vendor, no la red', () => {
    const src = readFileSync(join(RAIZ, 'dropi-wallet-sync/index.ts'), 'utf8');
    expect(src).toContain('../_shared/vendor/xlsx-0.20.3.mjs');
  });
});
