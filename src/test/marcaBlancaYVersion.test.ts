import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Guardias de "Guardian es de quien lo usa" (auditoría 2026-08-13).
 *
 * 1. MARCA BLANCA: Guardian se comparte con dueños de OTRAS tiendas. Un
 *    placeholder o un ejemplo que diga "Rushmira" (la tienda del dueño de la
 *    plataforma) le dice a un tercero que está usando el sistema de otro.
 *    Se vigila el texto de PANTALLA (.tsx); los comentarios de lógica en .ts
 *    que documentan incidentes reales de Rushmira son historia y se quedan.
 *
 * 2. AVISO DE VERSIÓN NUEVA: el hook debe estar montado y NO debe recargar la
 *    página por su cuenta — una operadora a mitad de una llamada, con datos
 *    escritos en un formulario, no puede perder la pantalla de golpe. Solo
 *    avisa; recargar es decisión de ella.
 */

function archivos(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivos(p, ext, out);
    else if (e.endsWith(ext) && !e.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

describe('marca blanca: ninguna pantalla nombra la tienda del dueño de la plataforma', () => {
  it('ningún .tsx de src/ contiene "Rushmira"', () => {
    const conMarca = archivos('src', '.tsx')
      .filter((f) => /rushmira/i.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/'));
    expect(conMarca).toEqual([]);
  });

  // `novedades.ts` es texto de PANTALLA aunque el archivo sea .ts: lo leen
  // duenos de tiendas distintas. El barrido de arriba solo mira .tsx, asi que
  // sin esta prueba una novedad podria nombrar la tienda del dueno de la
  // plataforma y nadie lo veria.
  it('el texto de novedades no nombra ninguna tienda concreta', () => {
    const src = readFileSync('src/lib/novedades.ts', 'utf8');
    expect(/rushmira/i.test(src)).toBe(false);
    // Anti-pase-vacio: si el archivo se moviera o quedara vacio, la prueba
    // pasaria por no haber mirado nada.
    expect(src).toContain('NOVEDADES');
  });
});

describe('aviso de versión nueva', () => {
  const hook = readFileSync('src/hooks/useVersionCheck.ts', 'utf8');

  it('está montado en el layout protegido (si no, no vigila nada)', () => {
    const layout = readFileSync('src/components/ProtectedLayout.tsx', 'utf8');
    expect(layout).toMatch(/useVersionCheck\(\)/);
  });

  it('NO recarga solo: la recarga vive únicamente en el botón del aviso', () => {
    // Debe existir exactamente una llamada a reload, y dentro del onClick del
    // toast — nunca suelta en el flujo del chequeo.
    const reloads = hook.match(/location\.reload\(\)/g) ?? [];
    expect(reloads).toHaveLength(1);
    expect(hook).toMatch(/onClick: \(\) => window\.location\.reload\(\)/);
  });

  // ⛔ 4-sep-2026, medido en vivo. El hosting fija una cookie
  // `__dpl=<id del despliegue>` que clava al navegador a la version que cargo.
  // Este chequeo mandaba la cookie, recibia el HTML del despliegue VIEJO, veia
  // el mismo hash de bundle y concluia "no hay nada nuevo": el aviso NO SALTABA
  // NUNCA despues de publicar. El mismo pedido sin cookie devolvia el
  // despliegue nuevo, cinco de cinco.
  it('pide el HTML SIN cookies, o no ve la version publicada', () => {
    expect(hook, 'volvio la cookie __dpl: el aviso de version nueva no va a saltar nunca')
      .toMatch(/credentials: 'omit'/);
    // Y sigue siendo el mismo pedido cache-busted de siempre.
    expect(hook).toMatch(/cache: 'no-store'/);
  });

  it('el aviso no se auto-cierra (una operadora ocupada no lo pierde)', () => {
    expect(hook).toMatch(/duration: Infinity/);
  });
});

describe('pantalla de error: distingue "se actualizó" de "se rompió"', () => {
  const eb = readFileSync('src/components/ErrorBoundary.tsx', 'utf8');

  it('reconoce el fallo de chunk viejo post-deploy', () => {
    expect(eb).toMatch(/dynamically imported module/);
    expect(eb).toMatch(/Guardian se actualizó/);
  });

  it('la recarga automática tiene guard anti-loop', () => {
    expect(eb).toMatch(/RELOAD_COOLDOWN_MS/);
    expect(eb).toMatch(/sessionStorage/);
  });
});
