import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: la app no le echa leña a una base que se está ahogando.
 *
 * ── La mañana del 5-sep-2026 ────────────────────────────────────────────────
 * La base de Supabase se congeló ~20 minutos (una consulta de UNA fila por
 * clave primaria: 130 ms → 9 s → 56 s → 302 s; `auth/health` con timeout a los
 * 30 s desde curl). Mientras tanto la app, desde cada pestaña, hacía justo lo
 * contrario de lo que hacía falta:
 *  - React Query reintentaba 3 veces cada consulta caída (su default).
 *  - 13 polls seguían disparando puntualmente.
 *  - `StoreContext` reintentaba `set_active_store` cada 30 s.
 *  - Cada gestión de una asesora disparaba por realtime 5-20 consultas en cada
 *    pestaña, con debounces de 400 ms a 1,5 s (RPCs de agregación incluidas).
 *  - `/seguimiento` lanzaba `dropi-refresh-batch` (~80 operaciones de base en
 *    30 s) al montar, por navegador, sin dejar rastro en sync_logs.
 * Una pestaña quieta en /admin acumuló 195 peticiones y 174 errores en 20 min.
 *
 * Esta prueba vigila que las piezas del freno sigan puestas. Si se pone roja,
 * el problema es tu cambio: alguna pieza se soltó.
 */

// Raíz del REPO (no de src/): las rutas de abajo empiezan por `src/`.
const RAIZ = join(__dirname, '..', '..');
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8');

/** Código sin comentarios (mismos índices), para no contar prosa como código. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * Devuelve, en ms, el último argumento de la llamada que empieza en `desde`
 * (justo después del `(`). Acepta un literal (`20_000`) o el nombre de una
 * constante declarada en el mismo archivo (`const PISO_X = 30_000`).
 */
function pisoDeLaLlamada(src: string, desde: number): number {
  let prof = 1;
  let ultimaComa = -1;
  let fin = -1;
  for (let j = desde; j < src.length; j++) {
    const c = src[j];
    if (c === '(' || c === '{' || c === '[') prof++;
    else if (c === ')' || c === '}' || c === ']') { prof--; if (prof === 0) { fin = j; break; } }
    else if (c === ',' && prof === 1) ultimaComa = j;
  }
  if (fin < 0 || ultimaComa < 0) return 0;
  const arg = src.slice(ultimaComa + 1, fin).trim();
  if (/^\d[\d_]*$/.test(arg)) return Number(arg.replace(/_/g, ''));
  const decl = src.match(new RegExp(`const ${arg}\\s*=\\s*(\\d[\\d_]*)`));
  return decl ? Number(decl[1].replace(/_/g, '')) : 0;
}

describe('⛔ el cortacircuitos de la base está cableado', () => {
  it('el cliente de Supabase usa fetchConFreno: es el único punto por donde pasa TODA petición', () => {
    const c = sinComentarios(leer('src/integrations/supabase/client.ts'));
    // Este archivo dice «automatically generated»: si Lovable lo regenera, la
    // línea se pierde y el freno queda ciego sin que nadie se entere. Por eso
    // se vigila acá y no se confía en la memoria de nadie.
    expect(c, 'client.ts perdió el import de fetchConFreno').toMatch(/import \{ fetchConFreno \} from '\.\/fetchConFreno'/);
    expect(c, 'client.ts perdió `global: { fetch: fetchConFreno }`: el freno no ve ninguna petición').toMatch(/global:\s*\{\s*fetch:\s*fetchConFreno\s*\}/);
  });

  it('fetchConFreno SOLO observa: no agrega timeouts ni reintentos', () => {
    const f = sinComentarios(leer('src/integrations/supabase/fetchConFreno.ts'));
    expect(f).toMatch(/registrarRespuesta/);
    expect(f, 'un timeout acá cortaría edge functions legítimas de 30 s').not.toMatch(/setTimeout|AbortController/);
    expect(f, 'un reintento acá multiplicaría la carga que el freno existe para bajar').not.toMatch(/for \(|while \(|retry/i);
  });

  it('pollWhenVisible se salta el tick con el freno abierto', () => {
    const p = sinComentarios(leer('src/lib/pollWhenVisible.ts'));
    expect(p).toMatch(/import \{ abierto, onCambio \} from '\.\/frenoBase'/);
    expect(p, 'el tick no pregunta abierto()').toMatch(/if \(abierto\(\)\)/);
  });

  it('React Query no reintenta 3 veces, y ninguna con el freno abierto', () => {
    const a = sinComentarios(leer('src/App.tsx'));
    expect(a, 'volvió el default de react-query: 3 reintentos con backoff contra una base ahogada').toMatch(/retry:\s*\(fallos\)\s*=>\s*fallos < 1 && !frenoAbierto\(\)/);
  });

  it('/seguimiento ya NO lanza dropi-refresh-batch al montar', () => {
    const s = sinComentarios(leer('src/components/tabs/SeguimientoTab.tsx'));
    expect(s, 'volvió el auto-sync al entrar: ~80 operaciones de base por navegador, invisible en sync_logs')
      .not.toMatch(/refreshNow\(activeStoreId,\s*\{\s*silent:\s*true\s*\}\)/);
    // El botón manual SÍ se conserva: quien necesita el dato ahora, lo pide.
    expect(s).toMatch(/refreshNow\(activeStoreId,\s*\{\s*force:\s*true\s*\}\)/);
  });

  it('los refetch disparados por realtime pasan por refetchConPiso, con piso de verdad', () => {
    const casos: Array<[string, number]> = [
      ['src/components/admin/ProductivityDashboard.tsx', 30_000],
      ['src/hooks/useInboxEsperando.ts', 20_000],
      ['src/hooks/useLiveTeam.ts', 20_000],
      ['src/components/SegCounterBar.tsx', 5_000],
    ];
    for (const [rel, minimo] of casos) {
      const src = sinComentarios(leer(rel));
      const i = src.indexOf('crearRefetchConPiso(');
      expect(i, `${rel} ya no usa crearRefetchConPiso`).toBeGreaterThan(-1);
      // El piso es el ÚLTIMO argumento de la llamada. Se lee con paréntesis
      // balanceados, no con una regex: la primera versión de esta prueba usaba
      // `[\s\S]*?` y saltaba desde la llamada hasta el primer `, 8)` que
      // hubiera en el archivo — daba 8 ms donde el código decía 30 s.
      const valor = pisoDeLaLlamada(src, i + 'crearRefetchConPiso('.length);
      expect(valor, `${rel}: el piso bajó de ${minimo} ms (o no se pudo leer)`).toBeGreaterThanOrEqual(minimo);
      // Y no volvió el debounce de milisegundos.
      expect(src, `${rel}: volvió un setTimeout de menos de 2 s sobre el canal`).not.toMatch(/setTimeout\([^)]*\),\s*(400|800|1000|1500)\)/);
    }
  });

  it('el aviso está en la cabecera: la asesora se entera de que es la base, no Guardian', () => {
    const l = sinComentarios(leer('src/components/ProtectedLayout.tsx'));
    expect(l).toMatch(/<FrenoBaseAviso \/>/);
    const aviso = leer('src/components/FrenoBaseAviso.tsx');
    expect(aviso).toMatch(/Lo que hagas se guarda igual/);
    expect(aviso).toMatch(/No es Guardian/);
  });

  it('el reintento del scope cada 30 s respeta el freno', () => {
    const s = sinComentarios(leer('src/contexts/StoreContext.tsx'));
    const i = s.indexOf('const otraVez = () =>');
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 600)).toMatch(/if \(frenoAbierto\(\)\) return;/);
  });
});
