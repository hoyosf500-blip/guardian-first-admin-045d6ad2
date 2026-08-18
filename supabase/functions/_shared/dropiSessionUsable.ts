// "El token no venció" ≠ "el token sirve".
//
// `ensureFreshSessionToken` decide renovar mirando el `exp` del JWT. Pero Dropi
// REVOCA tokens ANTES de ese exp — entrar al panel desde otro navegador es el
// caso típico. Entonces el token dice "vigente 24 h", Dropi contesta 401, y como
// nadie fuerza un re-login la asesora queda en un BUCLE: el botón "Reintentar"
// vuelve a mandar el MISMO token muerto. Encima el mensaje de dropiWebFetch la
// mandaba a "configurá el login automático" cuando ya estaba configurado.
//
// CASO REAL (Rushmira Colombia, 18-ago-2026): login automático activo y
// funcionando —renovó a las 08:23— y a las 10:08 el editor de pedidos no podía
// ni cargar los productos. Nada estaba mal configurado. Faltaba PROBAR el token
// en vez de creerle a su fecha de vencimiento.
//
// El daño caro no es el editor que no abre: es que el create-with-edit salga
// BIEN y muera el `PUT REEMPLAZADA` posterior. Ahí el pedido viejo queda vivo en
// Dropi, el cron lo vuelve a traer, y eso es exactamente como nace un pedido
// DUPLICADO (ver la memoria editor_orden_unificado).
//
// Cuesta un GET por operación. Se usa en caminos de EDICIÓN (raros, disparados
// por una persona), NUNCA en un cron por-tienda donde ese request se multiplica.
//
// ⚠️ Lo ÚNICO que se repite es el probe. Ninguna mutación se reintenta jamás:
// reintentar un create es lo que duplicó pedidos de verdad en julio-2026.

import { ensureFreshSessionToken } from "./dropiSessionLogin.ts";
import { dropiWebFetch, WebFallbackError } from "./dropiWebQuote.ts";

export interface SessionUsableCfg {
  storeId: string;
  base: string;
  sessionToken: string;
  storeUrl: string;
  /** Marca interna: en ESTA invocación el token ya se probó. Evita pagar el
   *  probe más de una vez cuando un mismo request pasa por varios puntos que
   *  aseguran la sesión — un `mode:"quote"` cruza DOS, y con el token revocado
   *  cada uno hacía probe→login→probe: seis requests y dos logins para cotizar
   *  una sola vez. Es exactamente la lentitud que se notó en Colombia. */
  _sesionProbada?: boolean;
}

/** Lectura barata e idempotente para saber si el session token sirve AHORA.
 *  'indeterminado' = falló por otra cosa (red, 5xx): no se toca el token y se
 *  deja que la llamada real muestre el error verdadero. */
export async function sessionProbe(
  cfg: SessionUsableCfg,
): Promise<"ok" | "token_malo" | "indeterminado"> {
  try {
    const { status } = await dropiWebFetch(
      cfg,
      "/api/orders/myorders?result_number=1&start=0",
      { method: "GET", logBody: false },
    );
    if (status >= 200 && status < 300) return "ok";
    if (status === 401 || status === 403) return "token_malo";
    return "indeterminado";
  } catch (e) {
    // dropiWebFetch convierte el 401 de Dropi en WebFallbackError 422.
    if (e instanceof WebFallbackError && e.status === 422) return "token_malo";
    return "indeterminado";
  }
}

/**
 * Deja `cfg.sessionToken` USABLE, no solo "no vencido". Muta `cfg` in situ, así
 * que todo lo que comparta ese objeto (liveness, quote, PUT) hereda el token
 * bueno sin pasarlo por parámetro.
 *
 * Tira `WebFallbackError` 422 con un mensaje que dice QUÉ hacer y que NUNCA
 * pide configurar algo que ya está configurado.
 */
export async function ensureSessionUsable(
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  cfg: SessionUsableCfg,
): Promise<void> {
  cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
  // Ya validado en este request: no se vuelve a pagar el probe. Si Dropi lo
  // revoca DESPUÉS, la llamada real igual falla con el mensaje claro de
  // dropiWebFetch — se pierde el auto-rescate en esa ventana, a cambio de no
  // meterle un request extra a cada paso de una edición.
  if (cfg._sesionProbada) return;
  if ((await sessionProbe(cfg)) !== "token_malo") { cfg._sesionProbada = true; return; }

  const anterior = cfg.sessionToken;
  cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg, { force: true });

  // ensureFreshSessionToken devuelve el token ACTUAL, sin tirar, cuando la
  // tienda no tiene login automático cargado. Ese silencio es el que dejaba a
  // una tienda recién dada de alta sin entender por qué, pasada una hora, no
  // puede volver a editar un pedido nunca más.
  if (cfg.sessionToken === anterior) {
    throw new WebFallbackError(
      "El acceso de esta tienda a Dropi se venció y la tienda NO tiene login automático " +
        "configurado. Andá a Admin → Credenciales Dropi y cargá el correo y la clave de Dropi " +
        "para que se renueve solo.",
      422,
    );
  }
  if ((await sessionProbe(cfg)) === "token_malo") {
    throw new WebFallbackError(
      "Dropi sigue rechazando el acceso aun después de volver a entrar con el correo y la clave " +
        "guardados en Admin → Credenciales Dropi. Revisá que esa clave siga siendo la correcta.",
      422,
    );
  }
  cfg._sesionProbada = true;
}
