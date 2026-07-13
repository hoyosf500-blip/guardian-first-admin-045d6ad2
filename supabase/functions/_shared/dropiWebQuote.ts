// Cotización de envío contra el panel WEB de Dropi (session token, no la
// integration-key). Extraído de shopify-push-dropi para reusarlo en
// dropi-change-carrier sin duplicar la secuencia probada.
//
// Secuencia (verificada en vivo, tienda EC, producto 155190 ALMAFIT, destino CUENCA/AZUAY):
//   A) GET  /api/products/productlist/v1/show/?id={dropiId}      → supplier_id, type
//   B) *** LA CIUDAD DESTINO YA NO SE RESUELVE ACÁ ***           → la trae el caller
//      El caller resuelve la ciudad destino contra la tabla Guardian
//      `dropi_city_catalog` y pasa `destCity` ya armado.
//      NOTA (2026-07-01): el 403 de /api/locations NO era bloqueo de IP de datacenter
//      (teoría vieja, FALSA). Era el WAF de Dropi rechazando fetches sin headers de
//      navegador — arreglado en `dropiWebFetch` (User-Agent + Referer + Sec-Fetch-*).
//      Con eso /api/locations también funcionaría desde el edge, pero el catálogo local
//      ya resuelve el destino sin depender de Dropi, así que se mantiene.
//   C) POST /api/orders/getOriginCityForCalculateShipping        → ciudad_remitente, warehouse
//      (destination = STRING "city, state", NO un cityId)
//   D) POST /api/orders/cotizaEnvioTransportadoraV2              → transportadoras + precio
//      (ciudad_destino = { id, name, department_id, cod_dane } — cod_dane REQUERIDO)
//
// `quoteCarriers` corre A, C, D (B lo hace el caller) y devuelve TODAS las
// transportadoras válidas (sin colapsar a la más barata) + los datos intermedios
// (dest/origin/products) para que el caller pueda crear la orden (PASO E) o solo
// mostrar opciones.

/** Config mínima para hablar con el panel web de Dropi. */
export interface DropiWebCfg {
  base: string;
  sessionToken: string;
  storeUrl: string;
}

/** Error tipado del flujo web para distinguir "abortar con 422" del resto.
 *  `body` (opcional) = body crudo que devolvió Dropi, para diagnóstico —
 *  dropi-change-carrier lo devuelve al cliente como `dropiBody`. Es el 3er
 *  parámetro opcional para no romper los throws existentes (message, status). */
export class WebFallbackError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status = 422, body?: unknown) {
    super(message);
    this.name = "WebFallbackError";
    this.status = status;
    this.body = body;
  }
}

/** MAYÚSCULAS sin tildes/acentos (para comparar ciudades/departamentos/nombres). */
export function normUp(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
}

/** Decodifica el payload (base64url) de un JWT y devuelve .sub (dropshipper id). */
export function decodeJwtSub(token: string): string {
  try {
    const part = token.split(".")[1];
    if (!part) return "";
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.sub != null ? String(payload.sub) : "";
  } catch {
    return "";
  }
}

/** fetch a /api/* con session token + log [dropi-web]. Tira WebFallbackError(422)
 *  si el endpoint responde 401 con mensaje típico de token inválido para /api/*. */
export async function dropiWebFetch(
  cfg: DropiWebCfg,
  path: string,
  // deno-lint-ignore no-explicit-any
  init: { method: "GET" | "POST" | "PUT"; body?: unknown; logBody?: boolean },
  // deno-lint-ignore no-explicit-any
): Promise<{ status: number; body: any; text: string }> {
  const url = `${cfg.base}${path}`;
  // El WAF de Dropi (Cloudflare-like) rechaza con 403 los requests que NO parecen
  // venir del navegador — NO es un bloqueo de IP de datacenter (esa teoría era falsa,
  // ver dropi-change-carrier). Firma mínima verificada en vivo 2026-07-01 (misma IP,
  // 200 vs 403): User-Agent de navegador + Referer/Origin de app.dropi.* + Sec-Fetch-Dest.
  // El fetch server-side de Deno manda "User-Agent: Deno/..." y omite sec-fetch-*, por eso
  // getOriginCity/cotiza/locations daban 403 desde el edge y 200 desde el browser.
  const appOrigin = cfg.base.replace("://api.", "://app."); // https://api.dropi.ec → https://app.dropi.ec
  // Origin DEBE ser el dominio de Dropi (app.dropi.*), NO la URL pública de la tienda
  // (cfg.storeUrl, ej. rushmira.com). Verificado en vivo 2026-07-01 (getOriginCity #96 vs
  // #102, MISMO token limpio): con Origin=app.dropi.ec → 200; el edge mandaba
  // Origin=rushmira.com y Dropi lo rechazaba con 401 (pasa el WAF pero la capa de auth
  // valida el Origin contra sus dominios). El panel real siempre manda Origin=app.dropi.ec.
  // El token se limpia de comillas por si un paste dejó `"eyJ..."` (también da 401).
  const cleanToken = String(cfg.sessionToken || "").replace(/^"+|"+$/g, "");
  const headers: Record<string, string> = {
    "X-Authorization": "Bearer " + cleanToken,
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "Origin": appOrigin,
    "Referer": `${appOrigin}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers,
      body: init.body != null ? JSON.stringify(init.body) : undefined,
      // Timeout duro: sin señal de aborto, un hang de Dropi mata la función por
      // wall-clock (a veces DESPUÉS de crear una orden) sin dejar rastro del motivo.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // AbortSignal.timeout aborta con DOMException "TimeoutError" (o "AbortError"
    // según runtime) — se convierte en error legible, no un TypeError críptico.
    // Status 504 y NO 0: los callers usan e.status como HTTP status de su
    // respuesta (shopify-push-dropi hace `json(..., e.status)`) y 0 es inválido.
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new WebFallbackError(`Dropi no respondió en 30s (${path}).`, 504);
    }
    throw e;
  }
  const text = await res.text();
  // logBody:false para endpoints que devuelven listados con datos de clientes
  // (nombre/teléfono/dirección) — evita volcar PII a los logs en cada llamada.
  console.log("[dropi-web]", {
    url,
    status: res.status,
    // 1000 chars (antes 400): los rechazos de create-with-edit traen el motivo
    // real más allá del message genérico "Error al crear la orden" — truncarlo
    // a 400 nos dejaba ciegos para diagnosticar (bug edición 2026-07-10).
    body: init.logBody === false ? `[omitido, ${text.length} chars]` : text.slice(0, 1000),
  });
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (res.status === 401) {
    const msg = String(body?.message || body?.error || text || "");
    if (/not issued to this api|could not be parsed|unauthenticated|token/i.test(msg) || !msg) {
      throw new WebFallbackError(
        "El token de sesión Dropi de la tienda venció o no sirve. Configurá el login automático (email + clave de Dropi) en Admin → Credenciales Dropi para que se renueve solo, o pegá un `dropi_session_token` fresco ahí mismo.",
        422,
      );
    }
  }
  return { status: res.status, body, text };
}

export interface WebProductInfo {
  dropiId: number;
  quantity: number;
  price: number;
  productType: string;
  supplierId: string | null;
}

/** Línea de pedido para cotizar. `productType`/`supplierId` se completan en PASO A. */
export interface QuoteLine {
  dropiId: number;
  quantity: number;
  price: number;
}

/** Ciudad destino ya resuelta por el caller (desde `dropi_city_catalog`).
 *  Reemplaza al viejo PASO B (/api/locations). */
export interface DestCity {
  cityId: number;
  name: string;
  departmentId: number | null;
  codDane: string;
}

/** Una transportadora cotizada por Dropi para esta ruta. */
export interface CarrierOption {
  id: number | string;
  name: string;
  typeService: string;
  shippingAmount: number;
}

/** Datos intermedios + opciones que devuelve `quoteCarriers`. */
export interface QuoteContext {
  /** Todas las transportadoras válidas (sin .error, con precio), ordenadas asc. NO filtra VELOCES. */
  options: CarrierOption[];
  dest: { cityId: number; idState: number; stateName: string; cityName: string };
  // deno-lint-ignore no-explicit-any
  origin: { cityRemitente: any; warehouse: any; warehouseId: number };
  products: WebProductInfo[];
  supplierId: string;
}

/** PASO A — datos del producto desde el catálogo web. supplier_id = objects.user_id,
 *  productType = objects.type (default SIMPLE). Si da 401 con session token igual
 *  seguimos: supplier_id cae al warehouse.user_id del PASO C. */
export async function fetchWebProductInfo(
  cfg: DropiWebCfg,
  dropiId: number,
  quantity: number,
  price: number,
): Promise<WebProductInfo> {
  let productType = "SIMPLE";
  let supplierId: string | null = null;
  try {
    const { status, body } = await dropiWebFetch(cfg, `/api/products/productlist/v1/show/?id=${dropiId}`, { method: "GET" });
    if (status >= 200 && status < 300) {
      const obj = body?.objects ?? body?.data ?? {};
      if (obj?.user_id != null) supplierId = String(obj.user_id);
      if (obj?.type) productType = String(obj.type);
    } else {
      // Antes degradaba a SIMPLE/supplier null en silencio total — dejar rastro.
      console.warn(`[dropi-web] PASO A: producto ${dropiId} respondió ${status} — degrado a type SIMPLE / supplier null`);
    }
  } catch (e) {
    // Un 401 acá NO aborta (a diferencia del resto): seguimos con fallback de supplier.
    // Pero si el session token es inválido de plano, los pasos C-D también fallarán.
    if (e instanceof WebFallbackError && e.status === 422) throw e;
    console.error("[dropi-web] PASO A falló para producto", dropiId, e);
  }
  return { dropiId, quantity, price, productType, supplierId };
}

/** PASO C — origen/bodega para un producto dado.
 *  ⚠️ `destination` es un STRING "city, state" (minúsculas ok), NO un cityId.
 *  Verificado en vivo 2026-07-01: getOriginCityForCalculateShipping espera el
 *  string; el cityId numérico NO resuelve el remitente. `data.city_dropi` es el
 *  OBJETO ciudad remitente (id, name, department_id, cod_dane, rate_type, ...). */
export async function getOriginCity(
  cfg: DropiWebCfg,
  dropiId: number,
  destination: string,
  productType: string,
  // deno-lint-ignore no-explicit-any
): Promise<{ cityRemitente: any; warehouse: any; warehouseId: number }> {
  const { status, body } = await dropiWebFetch(cfg, `/api/orders/getOriginCityForCalculateShipping`, {
    method: "POST",
    body: { id: dropiId, destination, type: productType },
  });
  if (status < 200 || status >= 300) {
    // El body de Dropi viaja en el error → el caller lo expone como dropiBody.
    throw new WebFallbackError(`Dropi /api/orders/getOriginCityForCalculateShipping respondió ${status}.`, 422, body);
  }
  const data = body?.data ?? {};
  const cityRemitente = data?.city_dropi ?? null;
  const warehouse = data?.warehouse ?? null;
  if (!cityRemitente) {
    throw new WebFallbackError(`El producto Dropi ${dropiId} no tiene stock en bodega (sin ciudad de origen).`, 422, body);
  }
  return { cityRemitente, warehouse, warehouseId: Number(warehouse?.id) };
}

/** PASO D — cotiza envío y devuelve TODAS las transportadoras válidas (asc por precio).
 *  NO filtra VELOCES: cada caller decide (shopify-push la excluye, change-carrier las muestra).
 *  ⚠️ ciudad_destino DEBE incluir cod_dane: con solo {id,name,department_id} Dropi
 *  responde "no se encontro ciudad remitente". El mínimo verificado es
 *  {id, name, department_id, cod_dane}. */
export async function cotizaEnvioOptions(
  cfg: DropiWebCfg,
  args: {
    // deno-lint-ignore no-explicit-any
    cityRemitente: any;
    destCity: DestCity;
    total: number;
    products: WebProductInfo[];
    // deno-lint-ignore no-explicit-any
    warehouse: any;
    warehouseId: number;
  },
): Promise<CarrierOption[]> {
  const reqBody = {
    peso: 1, largo: 1, ancho: 1, alto: 1,
    ciudad_remitente: args.cityRemitente,
    ciudad_destino: {
      id: args.destCity.cityId,
      name: args.destCity.name,
      department_id: args.destCity.departmentId,
      cod_dane: args.destCity.codDane,
    },
    EnvioConCobro: true,
    ValorDeclarado: args.total,
    insurance: false,
    products: args.products.map((p) => ({
      id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
    })),
    warehouse: args.warehouse,
    warehouse_id: args.warehouseId,
    zip_code: "",
    colonia: "",
  };
  const { status, body } = await dropiWebFetch(cfg, `/api/orders/cotizaEnvioTransportadoraV2`, { method: "POST", body: reqBody });
  if (status < 200 || status >= 300) {
    throw new WebFallbackError(`Dropi /api/orders/cotizaEnvioTransportadoraV2 respondió ${status}.`, 422, body);
  }
  // deno-lint-ignore no-explicit-any
  const options: any[] = Array.isArray(body?.objects) ? body.objects : [];
  // Candidatas: sin .error, con precioEnvio numérico y distributionCompany con id.
  const valid = options.filter((o) => {
    if (o?.error) return false;
    const precio = Number(o?.objects?.precioEnvio);
    return Number.isFinite(precio) && o?.distributionCompany?.id != null;
  });
  // 200 pero sin NINGUNA opción usable (isSuccess:false, objects vacío o todas
  // las transportadoras con .error): antes se devolvía lista vacía y el motivo
  // real de Dropi se perdía ("no cotizó" genérico en el caller). Se lanza con
  // el message de Dropi + los primeros .error por transportadora, y el body
  // completo como dropiBody.
  if (valid.length === 0) {
    const motivos = options
      .filter((o) => o?.error)
      .slice(0, 3)
      .map((o) => `${String(o?.distributionCompany?.name || o?.transportadora || "?")}: ${String(o.error).slice(0, 140)}`);
    const dropiMsg = String(body?.message || "").trim();
    throw new WebFallbackError(
      "Ninguna transportadora cotizó este envío." +
        (dropiMsg ? ` Dropi: ${dropiMsg}` : "") +
        (motivos.length ? ` — ${motivos.join(" | ")}` : ""),
      422,
      body,
    );
  }
  valid.sort((a, b) => Number(a?.objects?.precioEnvio) - Number(b?.objects?.precioEnvio));
  return valid.map((o) => ({
    id: o.distributionCompany.id,
    name: String(o.distributionCompany.name || o.transportadora || ""),
    typeService: String(o.transportadora_service || "normal"),
    shippingAmount: Number(o.objects.precioEnvio),
  }));
}

/** Orquesta A, C, D y devuelve opciones + contexto (dest/origin/products) para reusar.
 *  La ciudad destino (PASO B) la resuelve el caller contra `dropi_city_catalog` y la
 *  pasa como `destCity` — así evitamos /api/locations (403 desde la IP del edge). */
export async function quoteCarriers(
  cfg: DropiWebCfg,
  args: {
    country: string;
    city: string;
    state: string;
    destCity: DestCity;
    lines: QuoteLine[];
    total: number;
  },
): Promise<QuoteContext> {
  if (!cfg.sessionToken) {
    throw new WebFallbackError(
      "La tienda no tiene un token de sesión Dropi. La integration-key no sirve para el panel web de Dropi; configurá el login automático (email + clave) en Admin → Credenciales Dropi para que se genere solo, o pegá un `dropi_session_token` ahí mismo.",
      422,
    );
  }
  const lines = args.lines.filter((l) => l.dropiId != null);
  if (lines.length === 0) {
    throw new WebFallbackError("El pedido no tiene productos con id de Dropi para cotizar.", 422);
  }

  // PASO A — info de cada producto (supplier_id + type).
  const products: WebProductInfo[] = [];
  for (const l of lines) {
    products.push(await fetchWebProductInfo(cfg, Number(l.dropiId), l.quantity, l.price));
  }
  const primary = products[0]; // el primer producto manda para el cálculo de origen.

  // PASO B — ciudad destino: ya resuelta por el caller (dropi_city_catalog).
  const destCity = args.destCity;

  // PASO C — origen/bodega (asume proveedor compartido entre líneas).
  //  destination = STRING "city, state" (minúsculas ok, verificado en vivo).
  const destinationStr = `${String(args.city || "").trim()}, ${String(args.state || "").trim()}`
    .toLowerCase();
  const origin = await getOriginCity(cfg, primary.dropiId, destinationStr, primary.productType);

  // supplier_id: el del PASO A; fallback = warehouse.user_id del PASO C.
  const supplierId =
    primary.supplierId ??
    (origin.warehouse?.user_id != null ? String(origin.warehouse.user_id) : "");

  // PASO D — cotización (todas las líneas en products).
  const options = await cotizaEnvioOptions(cfg, {
    cityRemitente: origin.cityRemitente,
    destCity,
    total: args.total,
    products,
    warehouse: origin.warehouse,
    warehouseId: origin.warehouseId,
  });

  // dest: stateName/cityName vienen del pedido (string original); ids del catálogo.
  const dest = {
    cityId: destCity.cityId,
    idState: destCity.departmentId ?? 0,
    stateName: String(args.state || ""),
    cityName: destCity.name || String(args.city || ""),
  };

  return { options, dest, origin, products, supplierId };
}
