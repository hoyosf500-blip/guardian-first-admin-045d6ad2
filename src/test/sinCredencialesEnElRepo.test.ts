import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';

/**
 * GUARDIÁN: en el repo NO puede vivir ninguna credencial que no sea la pública.
 *
 * **Este repositorio es PÚBLICO.** Todo lo que se commitea queda legible para
 * cualquiera, para siempre — borrarlo después no lo des-publica.
 *
 * Ya pasó (18-jul-2026): la clave de integración de Dropi Ecuador quedó en el
 * historial. No es una clave cualquiera: vence en el año 2126, o sea que a
 * efectos prácticos NO vence. Con ella se pueden leer todos los pedidos de esa
 * cuenta —nombre, teléfono y dirección de cada cliente— y crear o modificar
 * órdenes. Estuvo pública alrededor de un mes.
 *
 * Qué se permite acá: SOLO JWTs con `"role":"anon"`. Esa clave viaja igual
 * dentro del bundle que corre en el navegador de cualquier visitante, así que
 * publicarla no agrega riesgo — y `permisosRolesAuditoria` prueba contra la
 * base REAL que no puede leer ni escribir nada.
 *
 * Qué NO se permite, y por qué cada uno:
 *  - `service_role`: se salta TODA la seguridad de la base. Es la única clave
 *    con la que alguien podría borrar la operación entera.
 *  - Claves de Dropi (`iss: app.dropi.*`): dan acceso a la cuenta real, a los
 *    datos de los clientes y a la plata.
 *
 * Si esta prueba se pone roja: NO alcanza con borrar el archivo. Hay que
 * ROTAR la credencial, porque ya se publicó.
 */

function archivosTrackeados(): string[] {
  return execSync('git ls-files', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n').map(s => s.trim()).filter(Boolean);
}

function payloadDeJwt(jwt: string): Record<string, unknown> | null {
  try {
    const p = jwt.split('.')[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{40,}/g;

describe('el repo es PÚBLICO: solo puede contener la clave anon', () => {
  it('ningún archivo versionado trae una credencial que no sea la pública', () => {
    const hallazgos: string[] = [];
    let leidos = 0;
    let vioLaAnon = false;
    // Se lee del DISCO, no con `git show` por archivo: con ~1.000 archivos
    // versionados eso tardaba casi un minuto y la prueba moría por timeout.
    for (const f of archivosTrackeados()) {
      let texto: string;
      try {
        if (statSync(f).size > 4 * 1024 * 1024) continue; // binarios/bundles
        texto = readFileSync(f, 'utf8');
        leidos++;
      } catch { continue; }
      for (const jwt of texto.match(JWT_RE) ?? []) {
        const pl = payloadDeJwt(jwt);
        if (!pl) continue;
        if (pl.role === 'anon') { vioLaAnon = true; continue; } // la única permitida
        const quien = pl.role === 'service_role'
          ? 'SERVICE_ROLE (se salta toda la seguridad de la base)'
          : `credencial externa (iss=${String(pl.iss ?? '?')}, aud=${String(pl.aud ?? '?')})`;
        hallazgos.push(`${f} → ${quien}`);
      }
    }
    // Sin estas dos guardas, un `git ls-files` vacío o un regex roto darían
    // VERDE sin haber mirado nada — un "todo limpio" mentiroso es peor que no
    // tener la prueba (misma lección que el badge de la billetera).
    expect(leidos, 'no se leyó ningún archivo: la prueba no probó nada').toBeGreaterThan(200);
    expect(vioLaAnon, 'no se encontró ni la clave anon: el detector no está detectando').toBe(true);
    expect(hallazgos, 'ROTAR la credencial: borrarla del repo NO la des-publica').toEqual([]);
  }, 60_000);
});
