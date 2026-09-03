import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — si una edge function elige la tienda por el BODY, tiene que
 * comprobar que quien la llama pertenece a esa tienda.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Encontrado el 3-sep-2026: `chateapro-sync` no leía **ni un solo header** en
 * 589 líneas. Cualquiera que pudiera invocarla elegía la empresa por el body o
 * —sin `store_id`— disparaba el sync de TODAS y recibía de vuelta el censo de
 * cada inquilino (contactos, pedidos esperando, errores). Y encima escribe:
 * hace UPDATE sobre `orders` de cada una de esas tiendas.
 *
 * «Hace falta estar logueado» NO es un candado: la clave anónima sale del
 * bundle JS, y `dropi-health` ya documenta ese mismo agujero explotado de
 * verdad (200 con el roster COMPLETO de tiendas).
 *
 * Mezclar empresas está PROHIBIDO en esta operación (REGLA #1 de CLAUDE.md): ya
 * costó 2h30 de pedidos de Ecuador entrando como Colombia, en la cola de una
 * asesora de otra empresa.
 *
 * Los guardianes que ya existían miraban otras cosas —consultas sin `store_id`,
 * ternarios de país, `external_id` sin tienda— y **ninguno miraba la
 * autorización**. Por ahí entró éste.
 *
 * ── Qué se acepta como candado ──────────────────────────────────────────────
 * Cualquiera de las formas que ya usa el repo: `isStoreMember`, una consulta a
 * `store_members`, el `x-cron-secret` compartido, o un chequeo de rol global
 * (`user_roles` / `has_role`). No se exige UNA forma: se exige que haya alguna.
 */

const RAIZ = join(process.cwd(), 'supabase', 'functions');

/** Comentarios fuera. `\r?\n` y no `\n`: con finales CRLF el `.` no cruza el
 *  `\r` y el borrado falla en silencio — la trampa que ya mordió tres veces
 *  acá. El `(?<!:)` evita confundir el `//` de una URL con un comentario. */
const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

const CANDADOS = [
  /isStoreMember/,
  // Gates MÁS estrictos que la membresía: exigen ser dueño (o encargado) de
  // ESA tienda. `dropi-sync` y `dropi-wallet-sync` los usan porque son
  // operaciones pesadas. Valen igual — el guárdian exige que HAYA un candado,
  // no uno en particular.
  /isStoreOwner/,
  /isStoreManager/,
  /from\(["']store_members["']\)/,
  /x-cron-secret/,
  /from\(["']user_roles["']\)/,
  /has_role/,
  /is_store_member/,
];

const funciones = readdirSync(RAIZ, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared')
  .map((d) => d.name)
  .filter((n) => existsSync(join(RAIZ, n, 'index.ts')));

describe('⛔ elegir la tienda por el body exige comprobar membresía', () => {
  it.each(funciones)('%s', (fn) => {
    const codigo = sinComentarios(readFileSync(join(RAIZ, fn, 'index.ts'), 'utf8'));
    // Solo aplica a las que dejan que el LLAMADOR elija la tienda.
    const eligeDelBody = /body[^\n]{0,40}\.?\[?["']?store_id/.test(codigo)
      || /body\?\.\s*store_id/.test(codigo)
      || /body\.store_id/.test(codigo);
    if (!eligeDelBody) return;
    expect(
      CANDADOS.some((re) => re.test(codigo)),
      `${fn} toma store_id del body y NO comprueba membresía ni cron-secret ni rol: `
        + 'cualquier llamador puede elegir la empresa de otro (o pedirlas todas).',
    ).toBe(true);
  });
});
