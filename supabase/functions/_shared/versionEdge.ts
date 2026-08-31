/**
 * Marca de versión de una edge function: la única forma de contestar DESDE
 * AFUERA "¿qué código está desplegado ahora mismo?".
 *
 * Por qué existe (30-ago-2026): Lovable no redespliega las edge functions al
 * publicar, y ya reportó "listo" tres veces mientras el runtime seguía en la
 * versión vieja. La auditoría del 30-ago se cerró pudiendo probar UNA sola de
 * las siete funciones desplegadas — `dropi-open-incidences`, porque su
 * respuesta cambió de forma. De las otras seis no había manera de saberlo:
 * `importchat-sync` tenía `VERSION` pero nadie la subió en el commit, así que
 * el ping devolvía la marca anterior y no distinguía nada.
 *
 * ⛔ El ping va por QUERY STRING (`?ping=1`), NO por el body.
 * El body de un `Request` se puede leer UNA sola vez: si el ping hiciera
 * `await req.json()` acá, el `req.json()` de más abajo (el que saca `store_id`)
 * devolvería `{}` — y como está envuelto en try/catch, el sync moriría con
 * "store_id requerido" SIN un solo error. Sería peor que el problema que
 * resuelve. `importchat-sync` puede leerlo del body porque ahí el body ya está
 * parseado y se reusa.
 *
 * Va ANTES de cualquier auth propia y no toca la base: la pregunta es sobre el
 * código, no sobre los datos. (La plataforma igual exige el JWT/apikey de
 * Supabase salvo que la función tenga `verify_jwt=false`.)
 *
 * @returns la respuesta del ping, o `null` si esta llamada no era un ping —
 *          para escribirlo como `const p = respuestaPing(...); if (p) return p;`
 */
export function respuestaPing(
  req: Request,
  version: string,
  headers: Record<string, string>,
): Response | null {
  let esPing = false;
  try {
    esPing = new URL(req.url).searchParams.get("ping") === "1";
  } catch {
    // URL inválida: no es un ping, seguimos con el flujo normal.
    return null;
  }
  if (!esPing) return null;
  return new Response(JSON.stringify({ ok: true, version }), {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
