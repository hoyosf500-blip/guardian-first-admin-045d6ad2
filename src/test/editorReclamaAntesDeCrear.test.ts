import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — el editor de pedidos reclama ANTES de crear en Dropi.
 *
 * `dropi-change-carrier` recrea el pedido (POST con `is_edit_order`, id nuevo)
 * en tres modos: apply, apply_value y apply_edit. Hasta el 4-sep-2026 no había
 * NADA que serializara dos requests sobre el mismo pedido: dos pestañas del
 * editor eran dos POST y dos órdenes nuevas vivas. Y un 5xx de Dropi se leía
 * como rechazo definitivo, el diálogo pedía reintentar, y el reintento creaba
 * la segunda.
 *
 * Es el mismo tipo de guardián que `duplicadoNoSeEscapaPorElLag`: lee el
 * fuente y exige el ORDEN de las cosas. `npm test` no corre las pruebas de las
 * edge functions, así que la única forma de vigilar esto desde CI es ésta.
 */

const RAIZ = join(process.cwd(), 'supabase', 'functions');
const fuente = readFileSync(join(RAIZ, 'dropi-change-carrier', 'index.ts'), 'utf8');

/** Comentarios fuera; `\r?\n` por los finales CRLF (ya mordió tres veces). */
const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

const codigo = sinComentarios(fuente);

/** Todas las posiciones de `needle` en `hay`. */
const posiciones = (hay: string, needle: string): number[] => {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
};

describe('⛔ el editor reclama antes de crear', () => {
  it('existe la tabla de intentos de edición (migración) y la función la usa', () => {
    const migs = readdirSync(join(process.cwd(), 'supabase', 'migrations'));
    expect(migs.some((m) => /dropi_edit_attempts/.test(m)), 'falta la migración de dropi_edit_attempts').toBe(true);
    expect(codigo).toMatch(/from\(["']dropi_edit_attempts["']\)/);
  });

  it('el claim corre ANTES de cada POST de creación (los tres modos)', () => {
    const iClaim = codigo.indexOf('claimEditAttempt(sbAdmin');
    expect(iClaim, 'nadie llama a claimEditAttempt').toBeGreaterThan(-1);
    const posts = posiciones(codigo, 'await postCreateWithEdit(cfg');
    expect(posts.length, 'se esperaban los tres modos que recrean').toBeGreaterThanOrEqual(3);
    for (const p of posts) {
      expect(iClaim, 'hay un POST de creación que no pasa por el claim').toBeLessThan(p);
    }
  });

  it('el claim se asienta como done INMEDIATAMENTE después del create, antes del PUT REEMPLAZADA', () => {
    // Solo los PUT de los tres modos (`const replacedX = ...`): dentro de
    // guardReplacedOldOrder hay un reintento del mismo PUT que no es un
    // call-site de creación.
    const marks = [...codigo.matchAll(/const replaced\w* = await markOldOrderReplaced\(cfg, externalId\)/g)]
      .map((m) => m.index ?? -1);
    expect(marks.length).toBeGreaterThanOrEqual(3);
    for (const m of marks) {
      const antes = codigo.slice(Math.max(0, m - 400), m);
      expect(antes, 'hay un PUT REEMPLAZADA sin asentar done antes').toMatch(/asentar\(\{\s*status:\s*"done"/);
    }
  });

  it('un 5xx / timeout del create-with-edit es INCIERTO, no un rechazo que invite al reintento', () => {
    expect(codigo).toMatch(/function esCreateIncierto\(/);
    expect(codigo).toMatch(/esCreateIncierto\(first\.status\)/);
    expect(codigo).toMatch(/esCreateIncierto\(second\.status\)/);
    // Y el incierto se asienta como unknown, nunca como error.
    expect(codigo).toMatch(/asentar\(\{\s*status:\s*"unknown"/);
  });

  it('done NO se reclaimea (una pestaña vieja crearía otra vez)', () => {
    const iClaimFn = codigo.indexOf('async function claimEditAttempt(');
    const cuerpo = codigo.slice(iClaimFn, iClaimFn + 4000);
    expect(cuerpo).toMatch(/ex\.status === "done"[\s\S]{0,200}ya_gestionado/);
  });

  it('lo que no llega al POST suelta el claim (finally)', () => {
    expect(codigo).toMatch(/finally\s*\{[\s\S]{0,400}attemptSettled[\s\S]{0,400}status:\s*"error"/);
  });

  it('sin presupuesto para crear + asentar, no se crea', () => {
    expect(codigo).toMatch(/EDIT_CREATE_MARGIN_MS/);
    const posts = posiciones(codigo, 'await postCreateWithEdit(cfg');
    for (const p of posts) {
      const antes = codigo.slice(Math.max(0, p - 600), p);
      expect(antes, 'un POST de creación no mira el presupuesto antes').toMatch(/EDIT_CREATE_MARGIN_MS/);
    }
  });

  it('el archivo de la migración existe y no toca tablas calientes', () => {
    const migs = readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter((m) => /dropi_edit_attempts/.test(m));
    for (const m of migs) {
      const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', m), 'utf8');
      expect(sql).toMatch(/SET lock_timeout/);
      expect(sql).not.toMatch(/ALTER TABLE public\.(orders|order_results|touchpoints)\b/);
    }
    expect(existsSync(join(RAIZ, 'dropi-change-carrier', 'index.ts'))).toBe(true);
  });
});
