import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Constantes fantasma en las edge functions.
 *
 * Las funciones de `supabase/functions` son Deno y NO pasan por ningún build de
 * este repo: `tsc`, ESLint y Vitest no las miran. Un identificador que se usa
 * pero nunca se declara no se nota hasta que revienta en producción.
 *
 * Pasó el 1-ago-2026: el commit dbadf0d agregó el paginado de
 * `dropi-nightly-reconcile` usando `GUARDIAN_PAGE_SIZE` y `GUARDIAN_MAX_ROWS`
 * sin declararlos. La reconciliación nocturna —la defensa contra pedidos
 * fantasma y contra estados divergentes vs Dropi— murió con
 * "GUARDIAN_PAGE_SIZE is not defined" en LAS DOS TIENDAS. Se supo porque el
 * badge de /logistica se puso rojo; sin ese badge habría seguido fallando en
 * silencio todas las noches.
 *
 * Esta prueba lo caza antes de subirlo. Mira solo nombres SNAKE_CASE con guion
 * bajo, que es la forma de las constantes de este repo: las palabras sueltas en
 * mayúscula ("PENDIENTE", "PUT") viven dentro de regex y de textos, y darían
 * falsos positivos.
 */

const RAIZ = 'supabase/functions';

/** Quita comentarios, textos y regex con un recorrido carácter por carácter.
 *  Con expresiones regulares las palabras en mayúscula de los comentarios en
 *  español se colaban como si fueran código. */
function soloCodigo(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  // Para distinguir `/` de división vs `/` de regex: tras un identificador o un
  // cierre de paréntesis es división; en cualquier otro caso, regex.
  let previo = '';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === '/' && !/[\w)\]]$/.test(previo)) {
      // Literal de regex: se salta entero (adentro hay estados en mayúscula).
      i++;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') { while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
        if (src[i] === '/') { i++; break; }
        i++;
      }
      while (i < n && /[gimsuyd]/.test(src[i])) i++;
      out += ' 0 '; previo = '0'; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1; i += 2; const start = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) i++;
          }
          // Adentro de ${...} SÍ hay código, pero puede traer sus propios
          // textos: se vuelve a limpiar en vez de inyectarlo crudo.
          out += ' ' + soloCodigo(src.slice(start, i)) + ' ';
          i++; continue;
        }
        i++;
      }
      out += ' "" '; previo = '"'; continue;
    }
    out += c;
    if (!/\s/.test(c)) previo = c;
    i++;
  }
  return out;
}

function archivosTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivosTs(p, out);
    else if (e.endsWith('.ts')) out.push(p);
  }
  return out;
}

function fantasmasDe(file: string): string[] {
  const code = soloCodigo(readFileSync(file, 'utf8'));

  const declarados = new Set<string>();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)/g)) declarados.add(m[1]);
  for (const m of code.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) declarados.add(m[1]);
  for (const m of code.matchAll(/import\s*\{([^}]*)\}/g))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) declarados.add(name);
    }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop()?.trim().replace(/=.*$/, '').trim();
      if (name) declarados.add(name);
    }

  const fantasmas: string[] = [];
  const vistos = new Set<string>();
  // SNAKE_CASE con al menos un guion bajo: la forma de las constantes de acá.
  for (const m of code.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    const u = m[1];
    if (vistos.has(u) || declarados.has(u)) continue;
    vistos.add(u);
    if (new RegExp('[\\w)\\]]\\s*\\.\\s*' + u + '\\b').test(code)) continue;  // algo.CONST
    if (new RegExp('[{,]\\s*' + u + '\\s*:').test(code)) continue;            // { CONST: x }
    fantasmas.push(u);
  }
  return fantasmas;
}

describe('edge functions: constantes usadas pero nunca declaradas', () => {
  const archivos = archivosTs(RAIZ);

  it('encuentra archivos que revisar (si no, la prueba no prueba nada)', () => {
    expect(archivos.length).toBeGreaterThan(20);
  });

  it('ninguna función usa una constante que no existe', () => {
    const rotos: string[] = [];
    for (const f of archivos) {
      for (const u of fantasmasDe(f)) rotos.push(`${f.replace(/\\/g, '/')} → ${u}`);
    }
    expect(rotos).toEqual([]);
  });

  // El caso real, para que la prueba demuestre que sabe cazarlo.
  it('sí detecta el patrón que tumbó la reconciliación nocturna', () => {
    const codigoRoto = `
      const PAGE_SIZE = 100;
      for (let o = 0; ; o += GUARDIAN_PAGE_SIZE) { console.log(o); }
    `;
    // Se ejerce el mismo análisis sobre un fuente en memoria.
    const code = soloCodigo(codigoRoto);
    const declarados = new Set<string>();
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declarados.add(m[1]);
    const usados = [...code.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1]);
    expect(usados.filter((u) => !declarados.has(u))).toEqual(['GUARDIAN_PAGE_SIZE']);
  });
});
