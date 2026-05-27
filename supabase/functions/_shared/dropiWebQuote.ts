// Cotización de envío contra el panel WEB de Dropi (session token, no la
// integration-key). Extraído de shopify-push-dropi para reusarlo en
// dropi-change-carrier sin duplicar la secuencia probada.
//
// Secuencia (verificada en vivo, tienda Rushmira Ecuador, FrescoMax id 115864):
//   A) GET  /api/products/productlist/v1/show/?id={dropiId}      → supplier_id, type
//   B) POST /api/locations { country }                           → cityId, stateName
//   C) POST /api/orders/getOriginCityForCalculateShipping        → ciudad_remitente, warehouse
//   D) POST /api/orders/cotizaEnvioTransportadoraV2              → transportadoras + precio
//
// `quoteCarriers` corre A–D y devuelve TODAS las transportadoras válidas
// (sin colapsar a la más barata) + los datos intermedios (dest/origin/products)
// para que el caller pueda crear la orden (PASO E) o solo mostrar opciones.

/** Config mínima para hablar con el panel web de Dropi. */
export interface DropiWebCfg {
  base: string;
  sessionToken: string;
  storeUrl: string;
}

/** Error tipado del flujo web para distinguir "abortar con 422" del resto. */
export class WebFallbackError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "WebFallbackError";
    this.status = status;
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
  init: { method: "GET" | "POST"; body?: unknown },
  // deno-lint-ignore no-explicit-any
): Promise<{ status: number; body: any; text: string }> {
  const url = `${cfg.base}${path}`;
  const headers: Record<string, string> = {
    "X-Authorization": "Bearer " + cfg.sessionToken,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (cfg.storeUrl) headers["Origin"] = cfg.storeUrl;
  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body != null ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  console.log("[dropi-web]", { url, status: res.status, body: text.slice(0, 400) });
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (res.status === 401) {
    const msg = String(body?.message || body?.error || text || "");
    if (/not issued to this api|could not be parsed|unauthenticated|token/i.test(msg) || !msg) {
      throw new WebFallbackError(
        "La tienda no tiene un token de sesión Dropi vigente. La integration-key no sirve para cotizar en el panel web de Dropi; pegá un `dropi_session_token` fresco en la config de la tienda (Admin → Credenciales Dropi).",
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
    }
  } catch (e) {
    // Un 401 acá NO aborta (a diferencia del resto): seguimos con fallback de supplier.
    // Pero si el session token es inválido de plano, los pasos B-D también fallarán.
    if (e instanceof WebFallbackError && e.status === 422) throw e;
  }
  return { dropiId, quantity, price, productType, supplierId };
}

/** PASO B — resuelve la ciudad destino contra el catálogo de Dropi del país.
 *  ⚠️ country DEBE ser exactamente "ECUADOR"/"COLOMBIA" (sino data:[] vacío). */
export async function resolveDestinationCity(
  cfg: DropiWebCfg,
  country: string,
  clientCity: string,
  clientState: string,
): Promise<{ cityId: number; idState: number; stateName: string; cityName: string }> {
  const { status, body } = await dropiWebFetch(cfg, `/api/locations`, { method: "POST", body: { country } });
  if (status < 200 || status >= 300) {
    throw new WebFallbackError(`Dropi /api/locations respondió ${status} al resolver la ciudad destino.`, 422);
  }
  // deno-lint-ignore no-explicit-any
  const states: any[] = Array.isArray(body?.data) ? body.data : [];
  if (states.length === 0) {
    throw new WebFallbackError(`Dropi devolvió un catálogo de ubicaciones vacío para ${country}.`, 422);
  }
  const wantState = normUp(clientState);
  const wantCity = normUp(clientCity);

  // Buscar el estado/departamento (exacto, luego por inclusión).
  let state =
    states.find((st) => normUp(st?.label) === wantState) ??
    (wantState ? states.find((st) => normUp(st?.label).includes(wantState) || wantState.includes(normUp(st?.label))) : undefined);

  // Si no matchea por departamento, buscar la ciudad en TODOS los estados.
  // deno-lint-ignore no-explicit-any
  const findCityIn = (st: any) => {
    // deno-lint-ignore no-explicit-any
    const items: any[] = Array.isArray(st?.items) ? st.items : [];
    return (
      items.find((c) => normUp(c?.label) === wantCity) ??
      (wantCity ? items.find((c) => normUp(c?.label).includes(wantCity) || wantCity.includes(normUp(c?.label))) : undefined)
    );
  };

  // deno-lint-ignore no-explicit-any
  let city: any | undefined;
  if (state) city = findCityIn(state);
  if (!city) {
    for (const st of states) {
      const hit = findCityIn(st);
      if (hit) { state = st; city = hit; break; }
    }
  }
  if (!state || !city) {
    throw new WebFallbackError(`Ciudad/Departamento no está en el catálogo Dropi: ${clientCity}/${clientState}`, 422);
  }
  return {
    cityId: Number(city.id_city),
    idState: Number(state.id_state),
    stateName: String(state.label),
    cityName: String(city.label),
  };
}

/** PASO C — origen/bodega para un producto dado. */
export async function getOriginCity(
  cfg: DropiWebCfg,
  dropiId: number,
  cityId: number,
  productType: string,
  // deno-lint-ignore no-explicit-any
): Promise<{ cityRemitente: any; warehouse: any; warehouseId: number }> {
  const { status, body } = await dropiWebFetch(cfg, `/api/orders/getOriginCityForCalculateShipping`, {
    method: "POST",
    body: { id: dropiId, destination: cityId, type: productType },
  });
  if (status < 200 || status >= 300) {
    throw new WebFallbackError(`Dropi /api/orders/getOriginCityForCalculateShipping respondió ${status}.`, 422);
  }
  const data = body?.data ?? {};
  const cityRemitente = data?.city_dropi ?? null;
  const warehouse = data?.warehouse ?? null;
  if (!cityRemitente) {
    throw new WebFallbackError(`El producto Dropi ${dropiId} no tiene stock en bodega (sin ciudad de origen).`, 422);
  }
  return { cityRemitente, warehouse, warehouseId: Number(warehouse?.id) };
}

/** PASO D — cotiza envío y devuelve TODAS las transportadoras válidas (asc por precio).
 *  NO filtra VELOCES: cada caller decide (shopify-push la excluye, change-carrier las muestra). */
export async function cotizaEnvioOptions(
  cfg: DropiWebCfg,
  args: {
    // deno-lint-ignore no-explicit-any
    cityRemitente: any;
    cityId: number;
    cityName: string;
    idState: number;
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
    ciudad_destino: { id: args.cityId, name: args.cityName, department_id: args.idState },
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
    throw new WebFallbackError(`Dropi /api/orders/cotizaEnvioTransportadoraV2 respondió ${status}.`, 422);
  }
  // deno-lint-ignore no-explicit-any
  const options: any[] = Array.isArray(body?.objects) ? body.objects : [];
  // Candidatas: sin .error, con precioEnvio numérico y distributionCompany con id.
  const valid = options.filter((o) => {
    if (o?.error) return false;
    const precio = Number(o?.objects?.precioEnvio);
    return Number.isFinite(precio) && o?.distributionCompany?.id != null;
  });
  valid.sort((a, b) => Number(a?.objects?.precioEnvio) - Number(b?.objects?.precioEnvio));
  return valid.map((o) => ({
    id: o.distributionCompany.id,
    name: String(o.distributionCompany.name || o.transportadora || ""),
    typeService: String(o.transportadora_service || "normal"),
    shippingAmount: Number(o.objects.precioEnvio),
  }));
}

/** Orquesta A–D y devuelve opciones + contexto (dest/origin/products) para reusar. */
export async function quoteCarriers(
  cfg: DropiWebCfg,
  args: { country: string; city: string; state: string; lines: QuoteLine[]; total: number },
): Promise<QuoteContext> {
  if (!cfg.sessionToken) {
    throw new WebFallbackError(
      "La tienda no tiene un token de sesión Dropi vigente. La integration-key no sirve para cotizar en el panel web de Dropi; pegá un `dropi_session_token` fresco en la config de la tienda (Admin → Credenciales Dropi).",
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

  // PASO B — ciudad destino.
  const dest = await resolveDestinationCity(cfg, args.country, args.city, args.state);

  // PASO C — origen/bodega (asume proveedor compartido entre líneas).
  const origin = await getOriginCity(cfg, primary.dropiId, dest.cityId, primary.productType);

  // supplier_id: el del PASO A; fallback = warehouse.user_id del PASO C.
  const supplierId =
    primary.supplierId ??
    (origin.warehouse?.user_id != null ? String(origin.warehouse.user_id) : "");

  // PASO D — cotización (todas las líneas en products).
  const options = await cotizaEnvioOptions(cfg, {
    cityRemitente: origin.cityRemitente,
    cityId: dest.cityId,
    cityName: dest.cityName,
    idState: dest.idState,
    total: args.total,
    products,
    warehouse: origin.warehouse,
    warehouseId: origin.warehouseId,
  });

  return { options, dest, origin, products, supplierId };
}
