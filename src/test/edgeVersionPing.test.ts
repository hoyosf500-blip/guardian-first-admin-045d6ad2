import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * ⛔ GUARDIÁN — poder preguntarle a una edge function QUÉ VERSIÓN está corriendo.
 *
 * Lovable no redespliega las edge functions al publicar, y ya reportó "listo"
 * mientras el runtime seguía en la versión vieja (tres rondas perdidas). El
 * 30-ago-2026 se desplegaron siete funciones y **solo una se pudo comprobar**:
 * `dropi-open-incidences`, de casualidad, porque su respuesta cambió de forma.
 * De las otras seis no había manera de saberlo. `importchat-sync` sí tenía
 * `VERSION`, pero el commit no la subió — así que el ping devolvía la marca
 * anterior y no distinguía nada, que es igual de inútil.
 *
 * Este guardián exige que las siete sigan teniendo la marca y que el ping se
 * conteste ANTES de la auth (si no, un ping desde afuera choca contra un 401 y
 * no contesta la pregunta).
 *
 * Comprobarlas todas desde el navegador, con sesión:
 *   POST {SUPABASE_URL}/functions/v1/{fn}?ping=1   →  { ok, version }
 */

const RAIZ = join(process.cwd(), "supabase", "functions");

/** Las que se despliegan a mano y por eso pueden quedar viejas sin avisar. */
const REQUERIDAS = [
  "dropi-cron",
  "dropi-sync",
  "dropi-refresh-batch",
  "dropi-nightly-reconcile",
  "importchat-sync",
  "resumen-diario",
  "dropi-open-incidences",
  // Las seis del chat. Las tres de ImporChat eran las únicas del repo que NO
  // podían contestar qué versión corrían — verificado el 2-sep-2026 pidiéndoles
  // `?ping=1` en producción: devolvían el error de validación de siempre. Y
  // justo ese día hubo que redesplegar `importchat-plantillas` por un cambio en
  // `_shared/plantillasMeta.ts`, sin ninguna forma de comprobar que llegó.
  "importchat-chat",
  "importchat-send",
  "importchat-plantillas",
  "chateapro-chat",
  "chateapro-send",
  "chateapro-plantillas",
  "chateapro-sync",
] as const;

/** Lo primero que aparece en el handler y ya es "auth". El ping va antes. */
const MARCAS_DE_AUTH = ["Authorization", "x-cron-secret", "auth.getUser", "SERVICE_ROLE_KEY"];

const leer = (fn: string): string | null => {
  const p = join(RAIZ, fn, "index.ts");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

const versionDe = (src: string): string | null =>
  src.match(/^const VERSION = "([^"]*)";/m)?.[1] ?? null;

describe("⛔ toda edge function que se despliega a mano dice su versión", () => {
  it.each(REQUERIDAS)("%s declara VERSION y contesta el ping", (fn) => {
    const src = leer(fn);
    expect(src, `no existe supabase/functions/${fn}/index.ts`).not.toBeNull();

    const v = versionDe(src!);
    expect(v, `${fn}: falta \`const VERSION = "..."\` — sin eso no se puede saber si el deploy entró`).toBeTruthy();
    expect(v!.trim().length, `${fn}: VERSION vacía`).toBeGreaterThan(3);

    expect(
      src!.includes('from "../_shared/versionEdge.ts"'),
      `${fn}: declara VERSION pero no importa respuestaPing — la marca no se puede consultar desde afuera`,
    ).toBe(true);
    expect(src!).toMatch(/respuestaPing\(\s*req\s*,\s*VERSION/);
  });

  it.each(REQUERIDAS)("%s contesta el ping ANTES de pedir credenciales", (fn) => {
    const src = leer(fn)!;
    const inicio = src.indexOf("Deno.serve(");
    expect(inicio, `${fn}: no encontré Deno.serve`).toBeGreaterThan(-1);
    const cuerpo = src.slice(inicio);

    const iPing = cuerpo.search(/respuestaPing\(\s*req/);
    const iAuth = Math.min(
      ...MARCAS_DE_AUTH.map((m) => {
        const i = cuerpo.indexOf(m);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      }),
    );
    expect(iPing).toBeGreaterThan(-1);
    expect(
      iPing,
      `${fn}: el ping está DESPUÉS de la auth — desde afuera devolvería 401 en vez de la versión`,
    ).toBeLessThan(iAuth);
  });

  it("dos funciones no comparten la misma VERSION", () => {
    // Copiar la línea de otra función y olvidar cambiarla deja dos funciones
    // contestando lo mismo: el ping pasa a mentir en vez de informar.
    const pares = REQUERIDAS.map((fn) => [fn, versionDe(leer(fn)!)] as const);
    const vistos = new Map<string, string>();
    for (const [fn, v] of pares) {
      expect(vistos.has(v!), `${fn} y ${vistos.get(v!)} comparten VERSION "${v}"`).toBe(false);
      vistos.set(v!, fn);
    }
  });

  it("una función que declara VERSION a medias no pasa", () => {
    // Vale para CUALQUIER edge function, no solo las siete: si alguien copia la
    // constante y no cablea el ping, la marca es decorativa.
    const conVersionSinPing: string[] = [];
    for (const d of readdirSync(RAIZ, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === "_shared") continue;
      const src = leer(d.name);
      if (!src || !versionDe(src)) continue;
      if (!/respuestaPing\(\s*req/.test(src) && !/body\?\.ping/.test(src)) conVersionSinPing.push(d.name);
    }
    expect(conVersionSinPing, `declaran VERSION pero nadie la puede consultar: ${conVersionSinPing.join(", ")}`).toEqual([]);
  });
});

describe("⛔ el ping NO puede leer el body", () => {
  it("respuestaPing sale de la query string, nunca de req.json()", () => {
    // El body de un Request se lee UNA sola vez. Si el ping hiciera req.json(),
    // el req.json() de más abajo — el que saca `store_id` — devolvería {} y,
    // como está en un try/catch, el sync moriría con "store_id requerido" SIN
    // un solo error. El helper existe justo para que eso no pueda pasar.
    const src = readFileSync(join(RAIZ, "_shared", "versionEdge.ts"), "utf8");
    // Sin comentarios: el propio archivo EXPLICA por qué no llamar a
    // `req.json()`, y esa explicación matchea la comprobación negativa. El
    // `(?<!:)` es para no confundir el `//` de una URL con un comentario — la
    // misma trampa que ya documentó `googleApagado.test.ts`.
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "");
    expect(codigo).toContain("searchParams");
    expect(codigo, "versionEdge.ts consume el body: rompería el parseo de store_id").not.toMatch(/req\.(json|text|formData|arrayBuffer)\s*\(/);
  });
});
