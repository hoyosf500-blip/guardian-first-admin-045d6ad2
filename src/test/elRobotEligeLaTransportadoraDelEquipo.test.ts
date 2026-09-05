// PRUEBA GUARDIANA (5-sep-2026). El robot creaba por el panel web con «la más
// barata ≠ VELOCES» y en Quito/Guayaquil eso es GINTRACOM. Medido en Rushmira
// Ecuador (29-ago → 5-sep): de 422 pedidos confirmados/despachados, 5 iban por
// GINTRACOM; en dos días las asesoras cambiaron 127 pedidos A MANO para salir
// de GINTRACOM (cada uno = orden nueva en Dropi, 30 % de REEMPLAZADA). La
// elección vive en `_shared/politicaTransportadora.ts` y el create web tiene
// que usarla, y REINTENTAR con la siguiente candidata cuando Dropi rechaza «la
// ciudad no tiene habilitado el método de envío» (7 veces en 2 días).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const raiz = resolve(__dirname, "../..");
const leer = (p: string) => readFileSync(resolve(raiz, p), "utf8");

describe("el robot elige la transportadora que el equipo elige a mano", () => {
  const push = leer("supabase/functions/shopify-push-dropi/index.ts");

  it("shopify-push-dropi importa la política compartida", () => {
    expect(push).toMatch(/import \{[^}]*\bordenarCandidatas\b[^}]*\} from "\.\.\/_shared\/politicaTransportadora\.ts"/);
    expect(push).toMatch(/\bpreferenciaTransportadora\(/);
    expect(push).toMatch(/\besRechazoPorMetodoDeEnvio\(/);
  });

  it("ya no existe la regla suelta «la más barata ≠ VELOCES» en el create web", () => {
    expect(push).not.toMatch(/options\.find\(\(o\) => normUp\(o\.name\) !== "VELOCES"\)/);
  });

  it("el create web recorre CANDIDATAS (reintenta con la siguiente), no una sola", () => {
    const ini = push.indexOf("async function createOrderViaWeb(");
    const fin = push.indexOf("async function findDuplicatesServiceRole(");
    expect(ini).toBeGreaterThan(0);
    const cuerpo = push.slice(ini, fin);
    expect(cuerpo).toMatch(/for \(const \[[^\]]*\] of candidatas\.entries\(\)\)|for \(const candidata of candidatas\)/);
    expect(cuerpo).toMatch(/esRechazoPorMetodoDeEnvio\(/);
    // Un rechazo INCIERTO (timeout, 5xx) jamás dispara el reintento: sería una segunda orden real.
    expect(cuerpo).toMatch(/incierto/);
  });

  it("la preferencia se lee por tienda (storeId viaja al create web)", () => {
    const ini = push.indexOf("async function createOrderViaWeb(");
    const fin = push.indexOf("async function findDuplicatesServiceRole(");
    expect(push.slice(ini, fin)).toMatch(/preferenciaTransportadora\(args\.storeId\)/);
  });

  it("VERSION de shopify-push-dropi subió en el mismo commit", () => {
    expect(push).toMatch(/const VERSION = "shopify-push-dropi 2026-09-05\.2 /);
  });
});
