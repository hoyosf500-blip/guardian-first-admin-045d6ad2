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

/** Sleep sincrónico: `execSync` es bloqueante, así que el reintento necesita
 *  esperar sin async. Es el modismo estándar de Node para esto. */
function dormir(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * ⛔ ESTA PRUEBA FALLA CERRADA: si no puede leer la lista de archivos se pone
 * ROJA, en vez de dar verde sin haber mirado nada. Eso está bien y no se toca.
 *
 * Pero "no pude mirar" y "encontré una clave" NO son lo mismo, y en rojo se
 * leían igual. El 4-sep-2026 esta prueba se puso roja en una corrida y verde en
 * la siguiente: la máquina venía tirando `fork: Resource temporarily
 * unavailable` y el `git ls-files` ni arrancaba. Un guardián de seguridad que
 * grita "fuga" por un hipo de la máquina enseña a ignorarlo -- y que se lo
 * ignore es la única forma de que una fuga de verdad pase desapercibida.
 *
 * Así que se reintenta (el fallo es transitorio por definición) y, si aun así
 * no se pudo, el mensaje dice CUÁL de las dos cosas pasó.
 */
function archivosTrackeados(): string[] {
  let ultimo: unknown = null;
  for (let intento = 0; intento < 3; intento++) {
    try {
      const salida = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split('\n').map((x) => x.trim()).filter(Boolean);
      if (salida.length) return salida;
      ultimo = new Error('`git ls-files` devolvió una lista vacía');
    } catch (e) { ultimo = e; }
    if (intento < 2) dormir(400 * (intento + 1));
  }
  throw new Error(
    'NO SE PUDO LEER EL REPO — esto NO es una fuga de credenciales. ' +
    '`git ls-files` falló 3 veces; casi siempre es la máquina sin poder crear ' +
    'procesos (fork: Resource temporarily unavailable), no un hallazgo. ' +
    'La prueba queda ROJA a propósito: sin la lista de archivos no se miró ' +
    'nada, y un verde ahí sería mentira. Volvé a correrla. ' +
    'Último error: ' + String((ultimo as Error)?.message ?? ultimo),
  );
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
