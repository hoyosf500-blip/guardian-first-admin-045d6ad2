# Arquitectura de Guardian — referencia detallada

> Salió de `CLAUDE.md` el 31-ago-2026. **No se cambió ni una palabra**: es el mismo texto,
> movido. `CLAUDE.md` pesaba ~23.200 tokens y viaja ENTERO en cada petición — hasta en un
> "hola" —, y el 76% era esta referencia. Nada de acá hace falta para no romper algo en
> cualquier tarea; hace falta cuando tocás el módulo puntual.
>
> **`CLAUDE.md` sigue mandando** sobre las reglas #0, #1 y #2, los comandos, el stack y las
> trampas de Lovable, y lleva el índice que dice cuándo abrir cada parte de acá.

## Lecciones de producción (sesión 2026-07-21)

- **"Corrió" y "funcionó" son dos preguntas distintas.** `useWalletSyncHealth` solo miraba
  *cuándo* corrió el cron, nunca *si guardó*: el badge marcaba verde mientras la billetera
  llevaba semanas muerta. Ahora existe el estado **`'failing'`** y manda sobre la frescura
  (`deriveStatus`: una corrida fallida hace 5 min es peor que una exitosa hace 6h). **Todo
  indicador de salud debe leer `status` + `error_message`, no solo el timestamp.** La fuente
  es `sync_logs` filtrando por `source` (`'dropi-wallet-sync'` para la billetera; el sync de
  ÓRDENES comparte tabla con `source='dropi'`).
- **Un string vacío en una columna UUID tumba el lote ENTERO.** `dropi-wallet-sync` pasaba
  `userId ?? ""` a `synced_by` (UUID nullable): Postgres respondía `invalid input syntax for
  type uuid: ""` y **rechazaba el batch completo, en todas las corridas y en las dos tiendas**.
  El cron dispara sin usuario autenticado, así que era siempre. Correcto: `syncedBy || null`.
  Al recuperar el histórico, EC pasó de 265 a 5.880 movimientos y CO a 1.725 — **las cifras de
  julio cambiaron**: antes se veía menos de un cuarto de la operación.
- **Un pedido BORRADO en Dropi NO es una cancelación del cliente.** `dropi-nightly-reconcile`
  los marcaba `CANCELADO` e inflaba la tasa de cancelación. Ahora marca **`ARCHIVADO GHOST`
  — CON ESPACIO**, que es la escritura canónica: los dos sitios que escriben
  (`dropi-nightly-reconcile/index.ts:388` y `:459`) usan espacio. Tras corregir 126 filas,
  julio EC quedó: cancelados 250 → 152 contra 154 de Dropi; entregados 216 = 216;
  devoluciones 70 = 70.

  **Corrección (2026-08-07): la justificación que había acá era falsa.** Este doc afirmaba
  que con guion bajo (`ARCHIVADO_GHOST`) "NO se excluye". **Sí se excluye:**
  `_estado_bucket` normaliza `_` → espacio ANTES del `CASE`
  (`20260707160000_estado_bucket_ec_states.sql:27-30`), así que las dos escrituras caen en
  el bucket `'borrado'`. La convención de escribir con espacio sigue en pie, pero **no
  dependas de ella como si fuera la única defensa** — y no gastes tiempo cazando guiones
  bajos creyendo que contaminan las métricas.

  **Dónde SÍ se cuela un fantasma** (y esto no lo arregla ninguna normalización): los
  filtros que comparan a mano contra `'REEMPLAZADA'` en vez de usar `_estado_bucket`.
  **Actualización 2026-08-20 — los 3 huecos que se listaban acá YA están cerrados en el
  repo:** `daily_reports` fue superseded por `20260807030000_daily_reports_excluir_fantasmas.sql`
  (usa `_estado_bucket <> 'borrado'`; verificar que sea la versión DESPLEGADA — regla #1),
  y `useDataLoader.ts` / `ConfirmarTab.tsx` excluyen explícitamente `ARCHIVADO GHOST` /
  `ARCHIVADO_GHOST`. El que quedaba sin filtro era **`/dashboard`** (`DashboardTab.tsx`
  cargaba TODOS los estados: 425 REEMPLAZADA + 102 ghosts de EC may–jul deflactaban la
  "Efect." por producto y engordaban la torta) — cerrado el 2026-08-20 excluyendo los
  tres estados en la query. Al agregar una query nueva sobre `orders`, excluir SIEMPRE
  los tres borrados o usar `_estado_bucket`.
- **Ficha de producto: UN solo componente.** `ProductoTile.tsx` dibuja talla/color (desde
  `orders.productos_detalle`, jsonb por línea, que llena `dropi-cron`) y lo usan **Confirmar y
  Seguimiento**. Antes eran dos copias y se arregló una sola — el bug reapareció en la otra
  pantalla. No volver a duplicarlo.
- **Guardian no inventa datos** (auditado 2026-07-21 contra un Excel oficial de Dropi): 380
  pedidos comparados uno por uno, CERO desacuerdos. Lo que tenía era de *más* (reemplazados +
  borrados), no de menos. Antes de sospechar de los datos, mirar si el estado es un soft-delete.

### Page / Tab Map

| Route | Page | Tab Component | Purpose |
|---|---|---|---|
| `/confirmar` | ConfirmarPage | ConfirmarTab | Call queue — confirm/cancel orders |
| `/seguimiento` | SeguimientoPage | SeguimientoTab | Track dispatched orders + dropdown "Listas SLA" estilo Boostec (8 listas pre-clasificadas por estado + días hábiles). Config en `src/lib/segLists.ts`. Lista activa persiste en URL (`?lista=...`) + sessionStorage. |
| `/novedades` | NovedadesPage | NovedadesTab | Resolve carrier incidences |
| `/admin` | AdminPage | AdminTab | Config por tienda. Gated `managerOnly` (owner/supervisor de la tienda activa). |
| `/dashboard` | DashboardPage | DashboardTab | KPI metrics |
| `/logistica` | LogisticsPage | LogisticaTab | Análisis: 8 sub-tabs (Resumen / Transportadoras / Ciudades / Productos / Decisiones / **Cancelaciones** / Finanzas / Balance). **Trazabilidad se ELIMINÓ el 24-ago-2026** a pedido del dueño ("yo no la miro") — con ella murieron TrazabilidadView, useLogisticsTimeline y la dona "Estado global"; la RPC `logistics_timeline` sigue desplegada sin consumidores. Gated `managerOnly`. Tab activa persiste en `useSessionState('logistica:tab')` con guarda: un valor guardado que ya no existe cae a Resumen (sin la guarda, Radix deja el body VACÍO). **Filtro de FECHA aplica a TODAS las tabs** (verificado 23-ago-2026: FinanzasTab recibe `filters` y usa fromDate/toDate — la versión anterior de esta fila decía lo contrario y confundió una auditoría). El filtro de **CIUDAD** es el que NO aplica a la plata (Finanzas/Balance/wallet — avisado con banner). El "Semáforo de salud financiera" se **eliminó** el 23-ago-2026 a pedido del dueño. |
| `/cfo` | CfoPage | CfoTab | Vista "Cómo voy" del dueño. **Triple gate:** ruta solo se registra si `VITE_ENABLE_CFO==='true'`, nav item es `adminOnly` (global `isAdmin`, no rol de tienda), y se oculta si `activeStore.country_code !== 'CO'`. RLS admin-only en la DB es el backstop. Reusa `financial_summary` + `logistics_summary` + `wallet_summary` + `product_profitability` y combina con inputs manuales mensuales (costos fijos, deuda TC, gasto pauta) vía hooks `useCfoMonthlyInputs` + `useTcDebtSnapshots` + `useMonthlyAdSpend` para calcular UTILIDAD NETA REAL. |
| `/plataforma` | PlataformaPage | — | Panel multi-inquilino del operador de la plataforma (listado de tiendas, suscripción, activar/desactivar). **La ruta se registra SIEMPRE**; el gate real está en la DB: las RPC `platform_stores_overview` / `platform_set_subscription` / `platform_set_store_status` tiran 42501 si el que llama no es admin global, y la página rebota a `/dashboard`. No confiar en el nav para esconderla. |
| `/como-se-trabaja` | ComoSeTrabajaPage | — | El protocolo del turno: la escalera de prioridad, qué se hace en cada escalón, qué significa cada lista y **qué NO es trabajo**. Nav para TODOS. **No tiene texto propio**: sale de `ESCALERA` (`siguienteAccion.ts`, la misma fuente de la barra "Lo que sigue") y del `queEs`/`queHacer` de cada lista en `segLists.ts`. Guardián `comoSeTrabaja.test.ts` impide agregar un escalón o una lista sin explicarlos. |
| `/pedido/:externalId` | OrderDetailPage | order-detail/* | Single-order drill-down (param es `:externalId`, no `:id`) |

Rutas públicas (fuera de `ProtectedLayout`): `/auth`, `/reset-password`, y **`/registro`** — que es
solo un `<Navigate>` a `/auth?registro=1` (alta de dueño nuevo + su tienda). Es el link que se
comparte por WhatsApp, así que depende de `VITE_PUBLIC_APP_URL`.

All authenticated routes share `ProtectedLayout`, which nests `StoreProvider → ProtectedLayoutInner → OrderProvider`. `ProtectedLayoutInner`:
- Blocks render while `auth.loading || store.loading` (first load only — see "single-app-mount" note below).
- Branches: no session → `/auth`; member of zero stores → "Sin tiendas asignadas" screen; `store.needsSetup` (owner + active store has no `dropi_api_key`) → `<SetupWizard>`.
- Renders the sidebar with `<StoreSelector>` and the store brand name/logo, filters `NAV_ITEMS` by gate (see below), and wraps the outlet in **`<WelcomeGate>`**. Shows `CounterBar` only on `/confirmar`.
- **⚠️ `OpeningReportGate` está MUERTO** (2026-07-19). El archivo sigue en el árbol pero `ProtectedLayout` ya no lo usa — solo queda un comentario donde estaba. Era un formulario de 4 pasos que BLOQUEABA (`fixed inset-0` sin Esc; una auditoría lo marcó como trampa de teclado). `WelcomeGate` lo reemplazó: no bloquea, una vez por día Bogotá vía localStorage (F5 no lo repite) y se muestra a todos, admin incluido. **Costo aceptado explícitamente:** las columnas `pedidos nuevos` / `guías de ayer` / `pendientes de ayer` de `/admin → Reportes diarios` y del CSV quedan vacías desde esa fecha. Desde `20260720120000` la **apertura la sella el heartbeat**, no un formulario (`COALESCE` preserva la PRIMERA marca del día, así reabrir el CRM no la pisa). El cierre diario sigue siendo manual y no se tocó.
- La lógica pura de apertura vive en `src/lib/aperturaTurno.ts` (`decidirApertura({esAdmin, marcaEntrada, ahora})`). Se extrajo porque **el dueño es admin y los admins no marcan entrada — el camino de la operadora no se puede ejercitar en su navegador**, así que se testea en vez de probarse a mano. Reglas: a un admin se lo saluda pero nunca se le muestra chip de turno (sería mentira); marca del server ausente/corrupta → saludar sin hora (NUNCA derivar la hora del reloj local); y si `first_action_at` es más viejo que `VENTANA_APERTURA_MS` (90s) es **re-entrada, no apertura** → ni saludo ni chip.
- Redeems pending store invites: a `?invite=TOKEN` from `/auth` is stashed in `localStorage('guardian.pendingInvite')` and consumed once via the `redeem_store_invite` RPC.

### Multi-Country (CO + EC + GT)

Each store has a `stores.country_code`. **Son TRES países en el código, no dos:** `'CO'` (default) · `'EC'` · `'GT'` (Guatemala). El host de la API sale de `_shared/dropiHosts.ts`, que mapea 13 países — pero solo CO/EC/GT tienen soporte de UI (geografía, teléfono, moneda, rastreo, feriados). Agregar un cuarto país es tocar TODOS esos ejes, no solo el host. The active store's country drives **carrier tracking URLs, phone normalization, currency formatting, business-day holidays, and the address heuristic** — all in `src/lib/`. Pure utils stay pure: they take an optional `countryCode?` param and default to `'CO'`, so existing CO call-sites and the CO tests are untouched.

- **Tracking URLs** (`getTrackingUrl(carrier, guia, countryCode?)` in `orderUtils.ts`): `CARRIER_TRACK` (CO) is the default map; `CARRIER_TRACK_EC` (GINTRACOM, LAARCOURIER, Servientrega EC) is **merged over** it for EC. **`CARRIER_TRACK_GT` NO hereda** el mapa colombiano — se usa solo (`cc === 'GT' ? CARRIER_TRACK_GT : ...`), a propósito: una guía GT abriendo el rastreo de una transportadora colombiana es peor que no tener link. `SERVIENTREGA` exists in BOTH CO and EC with different URLs — that collision is the whole reason tracking is country-scoped. Carriers whose URL ends in `=` get the guía appended.
- **Module-level country state — hay DOS, y las setea el mismo `useEffect`:** `getTrackingUrl` lee `_activeTrackingCountry` y `formatCOP` (`src/lib/utils.ts`) lee `_activeCurrencyCountry`, ambos default `'CO'`. `StoreContext` los sincroniza juntos con `setTrackingCountry(...)` + `setCurrencyCountry(...)` en un `useEffect` sobre `activeStore?.country_code` (`StoreContext.tsx`, buscar `setTrackingCountry` — NO por número de línea, se mueve). `formatCOP` **no es solo COP**: EC imprime USD con centavos y GT su propio formato; el nombre miente, la función no. This is the **same module-level-state pattern** as the address-validator `Set<string>` overrides — set once from context, read by pure functions without threading the value through every call-site. Los tests que tocan moneda deben restaurar (`afterEach(() => setCurrencyCountry('CO'))`) o contaminan al resto del archivo.
- **Phones** (`normalizePhoneForCountry` / `isValidPhoneForCountry` / `getWhatsAppPhone`): CO prefixes `57`, EC `593` (`normalizeEcuadorianPhone` strips a leading `0`), GT `502`. `getWhatsAppPhone` is what builds `wa.me/` links.
- **Días hábiles / feriados** (`orderUtils.ts`): el cálculo de días hábiles que alimenta las listas SLA usa el calendario de feriados del país — CO, EC y `getGuatemalanHolidays` (15-sep Independencia, 20-oct, 30-jun). Sin esto una tienda GT corría con los festivos colombianos y las listas SLA vencían el día equivocado.
- **Address validation:** `heuristicValidate(direccion, countryCode?)` and `buildAddressSuggestion(..., countryCode?)` tienen ramas por país; `src/lib/addressHeuristic.paises.test.ts` cubre CO/EC/GT en un solo suite justamente para que un cambio no arregle uno rompiendo otro.
- **Geografía del editor de pedidos es country-aware** (`CustomerForm.tsx`, el editor unificado): CO usa el catálogo DANE `src/lib/colombiaGeo.ts` (dropdown Departamento + Ciudad); EC usa `src/lib/ecuadorGeo.ts` (`PROVINCIAS_ECUADOR`, las 24 provincias con `<datalist>`) y GT `src/lib/guatemalaGeo.ts` (`DEPARTAMENTOS_GUATEMALA`), ambos con **ciudad/cantón/municipio como texto libre** (Dropi valida su lado; evita mismatch de nombres/casing). `CustomerForm` lee el país vía `useStore()`; ojo con `isGT`/`isEC` en las deps de los efectos — sin ellas, cambiar de tienda sin remontar deja el dropdown del país anterior. **NO hardcodear geografía de un solo país en formularios de dirección** — este fue exactamente el bug de "Ecuador mostraba departamentos de Colombia" (commit 4289aa5). El `PushToDropiModal` NO usa este catálogo (trae ciudades del catálogo de Dropi en vivo, ver `dropi-sync-city-catalog`).
- **CFO is CO-only** (`activeStore.country_code === 'CO'`) — see its triple gate above.

### Supabase Edge Functions

All functions are Deno (TypeScript). They live in `supabase/functions/`:
- `dropi-sync` — bulk-fetches orders from Dropi API, chunked in ≤89-day ranges, upserts to DB. Maps `o.shipping_amount` → **`orders.flete`** (lo que paga el dropshipper, NO lo cobrado al cliente; una versión anterior de esta línea decía `costo_logistico_dropi`, columna que NUNCA existió y mandó a una auditoría a cazarla). Uses Bearer API key.
- `dropi-update-order` — updates a single order's Dropi status (bearer token from DB settings)
- `dropi-update-order-full` — variant that also pushes back enriched address/notes payload to Dropi
- `dropi-refresh-order` — refresca UN pedido en vivo desde la API Dropi (`GET /integrations/orders/{external_id}`) y lo upsertea en `orders` por `external_id`. Disparado por el botón "Refrescar desde Dropi" en `CrmCallView`/`OrderCard` de Seguimiento (hook `useRefreshOrder`) para dar parity inmediata sin esperar al cron de 5 min (que en EC puede ir throttleado). Auth = JWT del miembro (valida `isStoreMember`). El UPDATE viaja a todos los clientes vía el realtime existente sobre `orders`. Devuelve `{ok, estado, guia, transportadora, rateLimited?}`. Comparte el mapper `mapDropiOrderToRow` (`_shared/dropiOrderMapper.ts`) con `dropi-sync` y `dropi-nightly-reconcile`.
- `dropi-change-carrier` — cambia la transportadora de un pedido pendiente desde Confirmar. `mode:"quote"` lee los productos del pedido (GET integrations por id) y cotiza en vivo vía `quoteCarriers` (`_shared/dropiWebQuote.ts`, session token web) → lista transportadoras + precio; `mode:"apply"` reasigna en Dropi vía `PUT /integrations/orders/myorders/{id}` con `{distribution_company_id}` (integration-key) + actualiza `orders.transportadora` + audita en `order_results` (`result:'cambio_transportadora'`). Solo sin guía generada. **OJO FASE 0:** el campo `distribution_company_id` del PUT es el candidato a confirmar — si Dropi lo rechaza, ver `dropiHttpStatus`/`dropiBody` y capturar el request real del panel. La cotización depende del `dropi_session_token` (legacy, vence ~1h).
- `dropi-relay` — generic proxy/relay to Dropi endpoints from the client (avoids CORS + hides session token)
- `dropi-refresh-batch` — el botón "Sincronizar Dropi" de Seguimiento. **Usa el endpoint de LISTA (~1 request por 200 pedidos), NO uno por pedido** — la versión per-order disparaba 429 y sincronizaba cero (fix 2026-06-23). UPSERTea (a diferencia de `dropi-snapshot`, que es read-only), así que el realtime existente mueve el tablero solo. Ventana default 10 días por "FECHA DE CAMBIO DE ESTATUS", backoff exponencial y presupuesto de 60s.
- `dropi-open-incidences` — devuelve los `external_id` con novedad **abierta AHORA** en Dropi. Existe porque un pedido puede quedar en estado `NOVEDAD` sin incidencia abierta (la transportadora la cerró/venció) y Dropi rechaza resolverla; Novedades usa esta lista para partir "Por gestionar" vs "Esperando transportadora". **Usa el session token web** — `/api/*` rechaza la integration-key. Siempre HTTP 200: si falla, el cliente degrada a una sola lista sin romperse.
- `dropi-resolve-incidence` — resolves a novedad on Dropi and marks it in DB. **⚠️ La marca
  LOCAL manda (decisión del dueño, 14-ago-2026):** "las novedades no se resuelven desde el CRM —
  la operadora lo hace desde Dropi y acá solo marca la opción; Dropi tiene demasiados estatus y
  no vale la pena ponerse en eso". `useNovedades.resolveNovedad` marca local + touchpoint y llama
  a esta función como CORTESÍA: **si Dropi rechaza el reporte, la marca NO se revierte** (la
  versión anterior la revertía y la novedad reaparecía en la cola → doble gestión). El único
  rollback que queda es si el UPDATE local mismo falla.
- `dropi-fingerprint` — generates a customer fingerprint for repeat-buyer detection
- `dropi-cron` — scheduled sync trigger. **Medido sobre `sync_logs` el 21-ago-2026: corre cada 10 min, y como reparte el presupuesto entre tiendas, a CADA TIENDA le toca cada ~20 min.** (El repo dice 15 min por la migration `20260716144619`; la base manda — REGLA #1.) Fue 5 min hasta jul-2026. **No hardcodear la cadencia en la UI**: `SyncFreshness` la deriva de las corridas reales vía `src/lib/cadenciaSync.ts`, porque el texto fijo "cada 5 min" quedó mintiendo por meses y es lo que hace que un pedido se lea como "desactualizado". Desde el cambio a 15 min NO hay 429 en `sync_logs`: la cuenta EC se estabilizó; no volver a 5 min sin una razón fuerte. **Resiliente a "zombie state":** intenta una cadena `STATUS_FILTER_VARIANTS` y persiste el ganador en `app_settings.dropi_winning_status_filter`. Si todos los filtros vuelven 0 sin error/throttle, marca `status='warn'` (no `success`) para que el banner de freshness pueda detectar "corre pero no trae nada". Ver `PLAN-PARITY-DROPI.md`.
- `dropi-health` — ping read-only por tienda contra `/integrations/orders/myorders` (page=1). Escribe `last_health_status` en `store_dropi_config` cada hora. Alimenta el banner `SyncFreshness` (verde=OK 24h, amarillo=zombie, rojo=error). Usa el `dropi_winning_status_filter` calculado por `dropi-cron`.
- `dropi-nightly-reconcile` — reconciliación diaria 3am UTC. Cancela huérfanos `PENDIENTE CONFIRMACION` con `external_id < 5M` que no se mueven hace +N días y barre divergencias estado-Guardian vs Dropi. Defensa contra zombies que sobreviven al cron.
- `dropi-webhook` — **INBOUND**: recibe los POST de cambio de estado de la **API OFICIAL de Integraciones** de Dropi (real-time, reemplaza polling para pedidos creados vía nuestra integración shop_type "Guardian"). Público (`verify_jwt=false`) pero **fail-closed** con `DROPI_WEBHOOK_SECRET` (header `x-dropi-secret`). UPDATE dirigido por `external_id` (estado/guía/transportadora, sella `fecha_conf`) sin pisar `valor/flete/costo_prod` (payload parcial); INSERT insert-only por si el pedido no existe. Siempre 200 salvo secreto inválido. La API oficial saliente (prod, IP whitelisteada) se enruta por el relay de IP fija del VPS — ver `vps/dropi-relay/README.md` y la memoria `dropi_integration_api_oficial`.

  **ESTADO (2026-07-22): la función existe y responde, pero el webhook NO está activo.** Falta
  (a) configurar `DROPI_WEBHOOK_SECRET` — sin él la función devuelve **401 a todo**, es
  fail-closed a propósito; (b) que Dropi registre la URL; (c) confirmar que la IP fija
  `2.25.69.238` esté whitelisteada.

  **⛔ BLOQUEANTE CON RIESGO DESTRUCTIVO — resolver ANTES de tocar la clave:** no está
  verificado si el token de la integración tipo `GUARDIAN` (el `shop_type` está confirmado en
  el panel de Dropi) lee **TODAS** las órdenes de la cuenta o **solo las suyas**. Si es solo
  las suyas y se reemplaza la clave actual, **se vacía el CRM**. Prueba segura antes de
  cambiar nada: consultar `/integrations/orders/myorders` con la clave nueva **sin guardarla**
  en `store_dropi_config` y comparar el total contra el de la clave actual. Si coinciden, lee
  todo; si la nueva devuelve mucho menos, NO cambiarla.

  **NO apagar el cron de pedidos (hoy cada 15 min)** hasta ver el webhook andando varios días en paralelo.
- `dropi-snapshot` — proxy server-side de auditoría: recibe `{store_id, from, to}`, pagina `/integrations/orders/myorders` (PAGE_SIZE 200, MAX_PAGES 30, backoff 2s/4s/8s en 429), filtra por `dropi_winning_status_filter` con fallback a "FECHA DE CAMBIO DE ESTATUS", devuelve `{orders, partial, message}`. Llamado por `DropiAuditModal` para comparar Dropi vs Guardian guía-por-guía. Existe por CORS — `api.dropi.co/ec` no permite fetch desde el browser.
- `dropi-verify-credentials` — prueba EN VIVO las 3 credenciales Dropi de una tienda y devuelve el HTTP crudo de cada una: (1) `api_key` contra `/integrations/orders/myorders` — **lo único bloqueante**, si falla el CRM nace vacío; (2) `login` vía `ensureFreshSessionToken(force)` — es lo que mantiene viva la billetera, sin él muere en una hora (le pasó a CO); (3) billetera con un rango de 1 día. **Owner-only, nunca devuelve tokens.** Existe porque el asistente de configuración decía "Tienda configurada" en verde sin probar nada. **La interpretación NO vive acá:** qué es bloqueante, qué es throttle y no credencial mala, y qué mensaje ve el cliente está en `src/lib/verificacionCredenciales.ts` (puro y testeado) — tocar ahí, no en la función.
- `dropi-sync-city-catalog` — vuelca el catálogo completo de provincias/ciudades de Dropi (`POST /api/locations`, session token web) en `dropi_city_catalog`, que alimenta los desplegables del editor de orden. **Upsert con `ignoreDuplicates=true`: solo INSERTA lo que falta, nunca pisa una fila existente** (respeta las cargadas a mano con `cod_dane` real). Re-ejecutable cuando Dropi agregue destinos. Auth = JWT de miembro.
- `dropi-validate-address` — validador de direcciones **100% GRATIS desde el 2026-08-06**: heurística regex + Nominatim/OSM (sin clave). Se le quitaron las llamadas a Google Address Validation y a Haiku, y con ellas el `consume_google_quota`. Devuelve el mismo contrato (`decision`/`missing_fields`/`suggested_*` quedan en su valor neutro) para no tocar `CallView`/`CrmCallView`.
- `dropi-wallet-sync` — descarga XLSX desde `/api/wallet/exportexcel`, parsea con SheetJS y upserta movimientos. Usa `mapCategoria()` para clasificar cada movimiento por código (regex + `normalizeCodigo` strip-accents). Default range = últimos 30 días — pasar body `{from, to}` para histórico. **Credencial (desde 2026-07-29):** cadena session token (via `ensureFreshSessionToken`, con UN re-login forzado si Dropi lo revocó o el guardado está corrupto) → api_key de fallback — Dropi dejó de aceptar la api_key en ese endpoint (401 "Token not issued to this api", ambas cuentas a la vez). Decodifica `payload.sub` del token QUE USA cada intento para el query `user_id`. Todos los fallos (incl. parseo XLSX y config faltante) escriben fila en `sync_logs`, y una corrida sana con 0 movimientos TAMBIÉN (contrato del badge). `ok:false` si el upsert RPC falla — nada de "Sync OK" en verde con la RPC rota.
- ~~`google-places-proxy`~~ — **ELIMINADA el 2026-08-06.** Era un proxy PURO a Google: cada llamada que entraba era plata que salía. Ya no existe en el repo; si quedó desplegada en Supabase, borrarla ahí también.
- `ai-order-assistant` — Claude-powered order assistant
- `shopify-push-dropi` — sube un pedido de Shopify a Dropi (anti-fuga). Resuelve el producto Dropi leyendo el metafield `dropi/_dropi_product` que Dropify deja en cada producto Shopify. `mode: "preview"` arma cliente+productos+total sin crear nada; `"confirm"` crea la orden (`POST /integrations/orders/myorders`) y registra en `shopify_pushed_orders` (idempotente). Auth = JWT de miembro de la tienda. La secuencia de cotización web (A–D: product/show → locations → getOriginCity → cotizaEnvioTransportadoraV2) vive en `_shared/dropiWebQuote.ts` (`quoteCarriers`) y la comparte con `dropi-change-carrier`; al crear sigue eligiendo la más barata ≠ VELOCES.
- `shopify-reconcile` — detecta pedidos de Shopify que NUNCA llegaron a Dropi cruzando por TELÉFONO (últimos 9 dígitos) contra `orders`. Body `{store_id, days?=3}`. Alimenta la cola anti-fuga.
- `shopify-auto-push` — robot de cron (**cada 15 min**, migration `20260718140000`) que sube a Dropi solo los pedidos Shopify LIMPIOS de tiendas con `auto_push_enabled`. La selección vive en `_shared/autoPushSelect.ts`: con teléfono, pasada una gracia de 30 min (deja que Dropify lo suba primero), menos de 3 días, no existente en Dropi, sin intento previo. **Sube llamando a `shopify-push-dropi` en `mode:"confirm"`**, así siguen aplicando todos los locks (anti-duplicado por teléfono, anti-sobreprecio, idempotencia) — el robot nunca fuerza nada; lo bloqueado cae al panel manual. Auth `x-cron-secret`. Body `{store_id?, dry_run?}`.
- **BOT DE WHATSAPP RETIRADO (2026-08-13) — estas 5 edge functions se borraron del repo; falta borrarlas en Supabase. Ver la sección de abajo.** ~~`wa-webhook` · `wa-send` · `wa-ai-responder` · `wa-status-notifier` · `wa-mine-conversations` — el bot de WhatsApp;~~ ver la sección "Bot de WhatsApp & gateway" más abajo. Dos datos operativos que no están ahí: **`wa-status-notifier`** (pg_cron ~10 min) escribe en la PRIMERA aparición de un pedido una fila baseline en `wa_order_notifications` **sin enviar nada** — así no bombardea el histórico; solo notifica transiciones posteriores. Tope `MAX_SENDS_PER_RUN = 40` y ventana `SEND_HOUR_END = 21` (08:00–21:00 Bogotá) que **aplica SOLO a envíos proactivos** — las respuestas reactivas del bot van 24/7. **`wa-send`** (botón manual de la asesora) escribe además un touchpoint `WHATSAPP: ...` con `operator_id`; el camino de la IA NO escribe touchpoints.
- `resumen-diario` — **el único aviso SALIENTE de Guardian** (antes no había ninguno: cero correo, cero mensajería en todo el repo). Cron 21:00 Bogotá (= `0 2 * * *` UTC, después del cierre del turno). Manda por **Resend** (`RESEND_API_KEY`; sin la clave NO finge — deja fila de error en `sync_logs`). Cuenta dos cosas SEPARADAS: lo que el equipo declaró al cerrar (`seg_cierres`) y lo que la base cuenta sola. **NO reimplementa `esAccionable` en SQL** — se apoya en el cierre firmado; una segunda definición se desincroniza sola. El contenido es puro en `_shared/resumenDiario.ts` y se testea desde `src/lib/resumenDiario.test.ts`.
- `parse-bank-pdf-text` — recibe el TEXTO plano de un extracto Bancolombia (Mastercard/Amex) — el cliente extrae el texto con `pdfjs-dist` en `CfoPersonalCardUploader.tsx`, porque pdfjs server-side no corre bien en edge — y devuelve movimientos categorizados; opcionalmente upserta. Alimenta el módulo de tarjeta personal del CFO.

Las credenciales Dropi son **por tienda** en `store_dropi_config` (`dropi_api_key` = INTEGRATIONS permanente; `dropi_session_token` = JWT de sesión legacy/fallback). Se leen en runtime vía `loadStoreConfig` (`_shared/dropiStoreConfig.ts`), NUNCA hardcoded. (El viejo `app_settings.dropi_token`/`dropi_session_token` era el modelo single-tenant previo.) Las credenciales **Shopify** viven en `store_shopify_config` y se leen vía `loadShopifyConfig` + `getShopifyAccessToken` (`_shared/shopifyStoreConfig.ts`) — usa client-credentials grant (token 24h auto-refresh; pegar un `shpss_` da 401). Todas las edge functions multi-tienda validan membresía con `isStoreMember` antes de tocar datos.

### Wallet Categorías (`mapCategoria` en `dropi-wallet-sync/index.ts`)

`dropi_wallet_movements.categoria` se llena vía regex sobre `codigo` (uppercase + NFD-stripped). Categorías válidas:

| Categoría | Patrón en código Dropi | Tipo típico | Significado |
|---|---|---|---|
| `flete_inicial` | `FLETE INICIAL` | SALIDA | Cargo al generar la guía |
| `cobro_entrega` | `CAMBIO DE ESTATUS` | ENTRADA | (raro) Cobro neto al entregar |
| `ganancia_dropshipper` | `GANANCIA` + `DROPSHIPPER` | ENTRADA | Markup que Dropi te paga por orden entregada |
| `ganancia_proveedor` | `GANANCIA` + `PROVEEDOR` | ENTRADA | Markup como proveedor |
| `reembolso_flete` | `DEVOLUCION` + `ORDEN ENTREGADA` | ENTRADA | Dropi devuelve flete inicial cuando entregó |
| `costo_devolucion` | `DEVOLUCION` + `NO EFECTIV` | SALIDA | Cargo extra cuando NO entregó (~$22k típico) |
| `comision_referidos` | `COMISION DE REFERIDOS` | SALIDA | Comisión a referidor |
| `mantenimiento_tarjeta` | `MANTENIMIENTO` + `TARJETA` | SALIDA | $12.5k/mes por tarjeta virtual |
| `indemnizacion` | `INDEMNIZACION` | ENTRADA | Compensación cuando proveedor no despacha |
| `retiro` | `TRANSFERENCIA` + `AL USUARIO` | SALIDA | Retiro a cuenta bancaria propia |
| `deposito` | `TRANSFERENCIA` + `DESDE EL USUARIO` | ENTRADA | Recarga manual |
| `orden_sin_recaudo` | `NUEVA ORDEN` | SALIDA | Cargo por nueva orden sin recaudo aún |
| `otro` | catch-all | — | Sin clasificar (revisar y agregar regex si es recurrente) |

**Si Dropi cambia el texto de un código,** el regex falla y el movimiento cae en `otro`. Diagnóstico: `SELECT codigo, COUNT(*) FROM dropi_wallet_movements WHERE categoria='otro' GROUP BY codigo;`. Después agregar pattern a `mapCategoria` Y crear migration `UPDATE` para re-categorizar movimientos viejos (patrón `20260502000005_recategorize_wallet_movements.sql`).

### Bot de WhatsApp — RETIRADO (2026-08-13)

> **El bot de WhatsApp se quitó por completo: no se usaba ni se iba a usar** (commit `0090a03`).
> Se borraron sus 5 edge functions (`wa-webhook`/`wa-send`/`wa-ai-responder`/`wa-status-notifier`/
> `wa-mine-conversations`), sus 6 librerías `_shared/wa*` (`waTransport`/`waTracking`/`waTranscribe`/
> `waMedia`/`waChannel`/`waPhone`), el inbox de Seguimiento y los paneles de `/admin` (Canales, Bot,
> Quick replies, Productos-bot). **`WaChatContext` quedó como STUB no-op** (misma firma
> `useWaChat`/`WaChatProvider`, `waEnabled=false`) a propósito, para NO tocar las 6 pantallas que lo
> consumían, varias frágiles (CallView, CrmCallView, CrmTable, NovedadView, SegBoard, OrderDetailPage);
> sus botones ya iban gateados por `waEnabled`. **Pendiente del dueño (fuera del repo):** desagendar
> los crons `wa-*`, DROP de las 11 tablas `wa_*` + `product_knowledge`, borrar el bucket `wa-audio` y
> eliminar las 5 edge functions ya desplegadas en Supabase. Ver memoria `whatsapp_bot_removido`.
>
> **Todo lo que sigue en esta sección es HISTÓRICO y ya no aplica.**

### ~~Bot de WhatsApp & gateway (multi-proveedor: Whapi / Evolution)~~ (histórico)

El bot "renta el caño, no el cerebro": el inbox + la IA viven en Guardian; el transporte (conexión a WhatsApp) lo provee un gateway QR detrás de **una sola interfaz agnóstica** `supabase/functions/_shared/waTransport.ts` (`WaTransport`: `sendText` + `parseInbound`). Implementados: **`WhapiTransport`** (Whapi.cloud, base `gate.whapi.cloud`, Bearer) y **`EvolutionTransport`** (Evolution API self-host: base = server propio, header `apikey`, opera por **instancia**; `POST /message/sendText/{instance}`, webhook `messages.upsert`). `cloud_api` queda como escape hatch. Swap de proveedor = registrar el canal con otro `provider` — **NO se toca** `wa-webhook`/`wa-send`/`wa-ai-responder`/inbox/realtime (todo agnóstico, store-scoped).

- **Canal por tienda** en `wa_channels` (`provider`/`instance_name`/`provider_token`/`provider_base`/`status`). Se registra desde **`/admin → Canales WhatsApp`** (`WaChannelsPanel.tsx` → RPC `upsert_wa_channel`, owner-only). El token es secreto (lo lee la edge function con service role). `loadWaChannel` (`_shared/waChannel.ts`) arma el transporte y pasa `instanceName` (Evolution lo necesita). **Un canal = una tienda** (toma el más reciente por `updated_at`); si una tienda necesitara 2 números habría que pasar `?channel_id=` en el webhook.
- **Contrato del webhook ENTRANTE** (`wa-webhook`, público, idempotente): el gateway debe POSTear a
  `=<SUPABASE_URL>/functions/v1/wa-webhook?secret=<WA_WEBHOOK_SECRET>&store_id=<UUID tienda>`.
  Secreto **global** (`WA_WEBHOOK_SECRET`, query `?secret=` o header `x-wa-secret`); el `store_id` resuelve la tienda → su provider → el `parseInbound` correcto. **Evolution:** configurar evento `messages.upsert` y **`webhookByEvents = false`** (si mete el nombre del evento en el path, rompe el query `?store_id=`). Grupos/difusión se ignoran.
- **Audio (notas de voz) + media sin texto — el bot NO se queda mudo (2026-06-26):** el filtro viejo `m.body` descartaba todo mensaje sin texto → una nota de voz no llegaba ni al inbox ni al bot. Ahora el filtro deja pasar `(m.body || m.media)`. `wa-webhook` graba YA el mensaje (con marcador si es media → idempotencia + la asesora lo ve) y responde rápido; en **background** (`EdgeRuntime.waitUntil`): si es AUDIO (`isAudioKind`), descarga el binario con `transport.fetchMediaBase64(id)` (Evolution: `POST /chat/getBase64FromMediaMessage/{instance}`) y lo TRANSCRIBE vía **kie.ai** (`_shared/waTranscribe.ts`, modelo `elevenlabs/speech-to-text` por su **job API** `createTask`→`recordInfo`), **reutilizando la MISMA key del bot `WA_AI_API_KEY`** (Claude NO procesa audio; por eso STT aparte). kie.ai pide el audio como URL → se sube a Supabase Storage (bucket `wa-audio`, **auto-creado** por la función) y se pasa una signed URL; se borra tras transcribir. El texto reemplaza el body (`🎧 …`) y RECIÉN AHÍ se dispara la IA (razona sobre lo que dijo el cliente). Otros media (foto/archivo/ubicación) → marcador legible (`_shared/waMedia.ts` `mediaMarker`). Falla de STT → marcador, el bot igual responde. Config opcional: `WA_STT_MODEL`, `WA_STT_INPUT_FIELD` (default `audio_url`), `WA_KIE_BASE`. **Cero keys/migraciones nuevas** — solo redeploy de `wa-webhook`. Visión de imágenes (Claude LEA la foto del comprobante) queda como fast-follow.
- **Guard `@lid` (`isLidJid` en `waTransport.ts`):** si el JID entrante llega como `@lid` (privacidad, sin resolver), `onlyDigits` daría dígitos basura → conversación fantasma + el bot respondiendo a un número inexistente = pérdida SILENCIOSA del cliente (auditoría 2026-06-26). `parseInbound` marca `isLid` y `wa-webhook` los OMITE con `console.warn` (visible, no silencioso). Resolver LID→teléfono es trabajo aparte.
- **Minería agnóstica** (`wa-mine-conversations`): para `provider='whapi'` lee el historial de la API de Whapi (`/chats` + `/messages/list`); para los demás lee de **`wa_messages`** (lo que el webhook/inbox ya guardó). Cron diario re-agendado en `20260626130000` (filtra `provider IN ('whapi','evolution')`).
- **Multi-número (CO + EC + personal):** cada número = su propia instancia Evolution en el server. CO/EC son **tiendas distintas** con su canal (bot activo). El número **personal** corre como instancia en el mismo server pero **fuera de Guardian** (no se registra como canal, sin bot).

### Key RPCs (Supabase DB Functions)

- `get_daily_operator_stats(p_date)` — returns per-operator KPI counts for the dashboard (admin-only)
- `dropi_fingerprint(phone)` — repeat-buyer detection
- `confirm_order_locally(p_order_id)` — atomic local confirmation that bypasses lock-expiry RLS issues
- `cancel_orphan_pending_orders()` — cancels stale `PENDIENTE CONFIRMACION` rows superseded by a new Dropi-synced order within 48h
- `claim_seg_order(p_order_id)` / `release_seg_order(p_order_id)` — claim/release helpers used by the Seguimiento queue
- `logistics_summary(from_date, to_date)` — KPIs globales (total/entregados/devueltos/valor)
- `logistics_by_carrier(from_date, to_date, min_orders)` — métricas por transportadora
- `logistics_by_city(from_date, to_date, min_orders, limit)` — top ciudades por tasa de devolución
- `logistics_by_product(from_date, to_date, min_orders, limit)` — top productos con peor tasa de entrega
- Todas SECURITY DEFINER + admin-only. Ver migration 20260427130000.
- `consume_google_quota()` — **ya no la llama nadie** (Google eliminado el 2026-08-06). La RPC y la tabla `address_autocomplete_cache` siguen en la base sin uso; borrarlas es opcional y no urgente.
- `cleanup_expired_autocomplete_cache()` — purges `address_autocomplete_cache` rows past TTL. Scheduled via pg_cron (migration `20260501010000_validador_direcciones_cron.sql`).
- `financial_summary(p_from_date, p_to_date)` — KPIs financieros del período (utilidad bruta contable). Versión actual = v6 (migration `20260502000008_financial_summary_v6_devoluciones.sql`). Fórmula: `ingresos − cogs − flete_entregadas − pérdida_devoluciones − comisión_referidos − mantenimiento_tarjeta + indemnizaciones`. Usado por hook `useFinancialSummary`. NO incluye gasto pauta (Fase B pendiente).
- `devoluciones_del_periodo(p_store_id, p_from, p_to)` — devoluciones LLEGADAS en el rango por `devuelto_at` (fecha Bogotá), con `de_meses_previos`. ADITIVA (14-ago-2026): las tasas por cohorte NO se tocaron — esta contesta "¿cuántas me golpearon ESTE período?" (cuando el wallet cobra). Membership check propio (owner/supervisor de esa tienda o admin), fail-closed. La consume `useDevolucionesDelPeriodo` → tarjeta en `/logistica → Resumen`; si la RPC no está aplicada la tarjeta no se dibuja. OJO: probarla en el SQL editor da 42501 (sin `auth.uid()`) — verificar EN LA APP.
- `cancelaciones_analisis(p_store_id, p_desde, p_hasta, p_limite)` — **una fila CRUDA por pedido cancelado** del período (cohorte por `orders.fecha`, misma población que `kpis_mensuales.cancelados` — tiene que cuadrar al pedido con esa columna). `is_store_manager` + 42501. La clasificación y las tasas NO están acá: viven en `src/lib/cancelTaxonomy.ts` + `src/lib/cancelacionesResumen.ts` (puros y testeados), para poder reclasificar el histórico sin migración. `origen='guardian'|'externo'` marca si hubo motivo capturado — `externo` = cancelado en el panel de Dropi / por la reconciliación nocturna, sin motivo posible. `total_periodo` y `generados_periodo` viajan en cada fila (calculados antes del LIMIT) → nunca se trunca en silencio y la tasa sale del mismo query. Ver "Módulo Cancelaciones" abajo.
- `wallet_summary(from, to)` y `wallet_daily_series(from, to)` — KPIs y serie temporal del wallet de Dropi. Admin-only, security definer.
- `upsert_wallet_movements(...)` — bulk INSERT idempotente sobre `dropi_wallet_movements` con `dropi_transaction_id` UNIQUE. RLS bloquea INSERT/UPDATE directo — todo va via este RPC.
- `operator_productivity_stats(p_range)` — KPIs por operador para `/admin → Productividad`. `p_range` ∈ `today | 7d | 30d` (ventanas alineadas a medianoche Bogotá desde la v3 `20260526140000`, NO rodantes). Tasas calculadas sobre INFLOW (entrantes en el período). Versión actual = **v4** (`20260528220000`) agrega 3 columnas de ESFUERZO sin tocar las existentes:
  - `intentos_noresp` — `COUNT(DISTINCT order_id)` con `result='noresp'` sin importar si después se cerró conf/canc. La columna original `noresp` mantiene el filtro `NOT EXISTS conf/canc posterior` (estado actual del pedido). Son métricas distintas.
  - `intentos_total` — `COUNT(*)` acciones de confirmar (no distinct).
  - `pendientes_sin_tocar` — `GREATEST(entrantes_global − atendidos_del_op, 0)`.
- `operator_activity_stats(p_range)` y `record_operator_heartbeat(p_store_id, p_active_seconds, p_idle_seconds)` — tracking de jornada (migration `20260528190848` + `20260528210000` para excluir admins). El cliente sube buckets cada 60s vía hook `useOperatorHeartbeat`; la RPC de lectura agrega por operador y excluye admins server-side. Ver sección "Productividad operadora: jornada + cobertura del día".
- `today_call_stats()` y `submit_closing_report(p_notes)` — cierre diario por operador. `submit_closing_report` deduplica si ya hay un cierre hoy (migration `20260505200000_fix_closing_dedup.sql`).
- `admin_daily_reports_range(p_from, p_to)` y `admin_operator_shifts_range(p_from, p_to)` — reportes admin por rango. Devuelven una fila por (operador, día), no agregado por operador. Usar para tabla histórica de cierres.
- **CFO inputs (manual)** — admin-only, security definer:
  - `upsert_monthly_business_inputs(p_year_month, ...)` — costos fijos, opex, salarios mensuales (tabla `monthly_business_inputs`).
  - `upsert_tc_debt_snapshot(...)` / read via `tc_debt_snapshots` — snapshots de deuda tarjeta de crédito (USD + COP).
  - `upsert_monthly_ad_spend(p_year_month, ...)` y `delete_monthly_ad_spend(p_id)` — gasto en pauta por canal/mes (tabla `monthly_ad_spend`).
  - `product_profitability(p_from_date, p_to_date)` — rentabilidad por producto combinando ingresos, COGS, flete y devoluciones.

### Módulo Finanzas — dos hooks distintos, NO confundir

`/logistica → Finanzas` muestra DOS perspectivas distintas de la misma operación:

**1. Utilidad Bruta Contable** (hook `useFinancialSummary`):
- Fórmula: `ingresos − COGS − flete − pérdida_devoluciones − comisión_referidos − mantenimiento_tarjeta + indemnizaciones`
- Incluye **COGS** aunque el cliente NO lo paga directo (Dropi le paga al proveedor). Es la utilidad "como si pagara todo".
- Sirve para análisis contable estándar.

**2. Ganancia Neta Dropi REAL** (hook `useGananciaNetaDropi`, card hero principal):
- Fórmula: `SUM(ENTRADAS operativas) − SUM(SALIDAS operativas)` desde wallet
- ENTRADAS: `ganancia_dropshipper`, `ganancia_proveedor`, `reembolso_flete`, `indemnizacion`
- SALIDAS: `flete_inicial`, `costo_devolucion`, `comision_referidos`, `mantenimiento_tarjeta`, `orden_sin_recaudo`
- EXCLUYE `retiro`, `deposito`, `otro`, `transferencia_externa` (movimientos de tesorería, no afectan ganancia operativa)
- Es el cash flow REAL — lo que entró/salió del wallet de Dropi.
- Sirve para decisión "estoy ganando plata o no".

**No mezclar las dos.** Si querés ver "lo que Dropi me pagó" → Ganancia Neta. Si querés perspectiva contable/comparable con Boostec → Utilidad Bruta.

### Módulo Cancelaciones — motivos, taxonomía y reagendar (15-ago-2026)

Nació de "tengo cancelaciones altas y no sé por qué". Los 7 motivos viejos mezclaban tres
preguntas en un campo: `'No contesta'` es un resultado, `'Cambio de transportadora'` no es una
cancelación (es una edición, con su propio `result='cambio_transportadora'`), y
`'Cambió de opinión'` era el tacho donde caían precio, demora, competencia y "no lo pedí".

- **`src/lib/cancelTaxonomy.ts`** — molde exacto de `novedadTaxonomy.ts` (normalizar → `RULES[]`
  ordenada → primera que matchea gana → catch-all). Devuelve **tres ejes**: `categoria` (qué
  pasó) · `culpa` (de quién) · `tipo` (cuánto duele). Dos decisiones que no son cosméticas:
  - **`tipo: 'ahorro'`** — cancelar por duplicado / mal historial EVITÓ una devolución (~$22k).
    Meterlo en la misma tasa que una venta perdida esconde la plata.
  - **`tipo: 'desconocido'`** — las canceladas en Dropi no tienen motivo; asignarles evitable o
    inevitable sería inventar el dato. Ese bucket se achica solo a medida que mejora la captura,
    y **esa reducción es el KPI del proyecto**.
  - `cuentaEnTasa: false` para los recreados (cambio de transportadora, edición): el pedido no se
    perdió, se rehizo con otro `external_id`. Contarlo es contar la venta dos veces.
  - Clasifica los 7 valores viejos y el string automático de `ConfirmarTab.tsx:1072`, así que **el
    histórico sirve sin backfill**. Dos pruebas guardianas lo fijan: ningún `value` del picklist
    puede quedar sin regla, y el histórico no se puede desclasificar refactorizando.
- **`CANCEL_REASONS`** (`constants.ts`) pasó de `string[]` a `CancelReasonOption[]`. **El atajo va
  en `hotkey`, no por posición** — antes era `CANCEL_REASONS[k-1]` y agregar o reordenar un motivo
  le remapeaba las teclas a la operadora en silencio. `value` es la clave del histórico y NO se
  cambia; para cambiar lo que ve la asesora se cambia `label`.
- **Reagendar** (`useReagendarPedido` + `REAGENDA_PRESETS` en `reminders.ts`) — salida del modal de
  cancelación que NO cancela. **Cero migraciones**: escribe una nota con `remind_at` (que la
  máquina existente `useOrderNotesIndex → hasDueReminder → BUCKET_REMINDER` sube sola al tope de la
  cola el día que vence) más un touchpoint `REAGENDA:`.
  - **⚠️ NO pasa por `markResult` a propósito.** Ese guard (`if (!user || order.result) return`,
    `OrderContext.tsx:1050`) dejaría el pedido imposible de confirmar después — justo el pedido que
    se reagendó para poder venderlo.
  - **No se tocó el CHECK de `order_results`**: sin la migración aplicada (Lovable no las
    auto-aplica) un `result='reagendado'` devuelve 23514 y le rompe el botón a la operadora.
  - `estaAplazado()` saca los reagendados del filtro "Pendientes" pero **nunca los esconde**:
    tienen chip propio con la cuenta y su lista. Es la lección de `resumenSinRespuestaHoy` (los "no
    contestó" enfriando desaparecían sin decir cuándo volvían).
  - **Riesgo conocido:** la tasa oficial es `conf ÷ (conf+canc+noresp)` y una reagenda no entra al
    denominador → reagendar en vez de cancelar **sube la tasa**. Por eso la RPC devuelve
    `reagendas` por pedido y el reporte muestra las "reagendas quemadas"; 2+ es una bandera.
- **`/logistica → Cancelaciones`** (`CancelacionesTab.tsx` + `useCancelacionesAnalisis`). La
  **cobertura del dato va primero, no al pie**: si el 30% tiene motivo hay que decirlo antes de
  mostrar un gráfico. Con cobertura 0% se ocultan motivo y culpa pero **el resto sigue
  funcionando** (sin-gestión, intentos, tiempo al primer toque, tabla) — no necesitan ni un motivo.
  - **Denominador declarado**: pedidos CREADOS en el rango, cancelados incluidos, `borrado`
    excluido. Coincide con `financial_summary` y **difiere a propósito de `logistics_summary`**
    (que saca los cancelados de su total). El pie de la pantalla lo explica.
  - **La regla discutible, explícita**: una cancelación sin NINGUNA gestión cuenta como *pérdida
    evitable* aunque el motivo culpe al cliente — nadie verificó ese motivo. Queda contada aparte
    en `evitablesPorSinGestion` para poder discutirla con datos (auditoría julio EC: 68 de 345).
- **Lo que NO se hizo y sería el siguiente paso**: cruzar los cancelados contra recompras del mismo
  teléfono ("recuperados"). En julio EC, 49 de 345 eran re-emisiones y **32 terminaron entregadas**
  — o sea, cancelado ≠ perdido. Necesita un LATERAL más en la RPC.

### Protocolo del turno — las piezas y sus reglas duras

Nació de *"que el colaborador nunca se quede quieto, que sepa qué hacer sin yo estar encima"*.
El orden es **por lo que se pierde si espera un día más**, no por antigüedad.

- **`src/lib/siguienteAccion.ts`** — la escalera (novedades · agencia · confirmar · detenidos ·
  rescate · catch-all) y su copy, en `ESCALERA`, escrita UNA sola vez: la barra y
  `/como-se-trabaja` la leen de ahí. Invariante fijado por prueba: **el guard de inactividad ve
  trabajo ⟹ la barra NO dice "al día"** (implicación, no equivalencia). El escalón 6 existe solo
  para sostenerla.
- **⛔ `segCargado`** — `segData` SOLO lo cargaba `SeguimientoTab`, y la barra se esconde en esa
  pantalla: en toda pantalla donde la barra SE VE la cola llegaba vacía y cuatro de los seis
  escalones no podían dispararse nunca ("Todo al día" en verde con 7 detenidos y 5 paquetes en
  agencia, medido en el Dashboard de CO el 21-ago-2026). Ahora **la barra pide la cola** y con
  `segCargado:false` devuelve `'cargando'` y no dibuja nada.
- **Asignación (`seg_asignaciones`)** = etiqueta de responsabilidad, **NUNCA candado**.
- **Cierre del día (`seg_cierres` + RPC `cerrar_seguimiento`)** — el trabajo de Seguimiento no
  tenía final; ahora **o queda en cero, o queda escrito el motivo** (CHECK en la tabla, no solo en
  el cliente). NO bloquea a nadie. El día se calcula en el SERVIDOR en hora Bogotá.
- **Regla transversal de todas estas piezas: cero NUNCA sustituye a "no se pudo medir".** Si la
  lectura de gestiones falla, los conteos van en `null`/`—` y el cierre se niega a firmarse.
  Un 0 acá es un reclamo injusto a una persona por un dato que nunca existió.
- **Una sola definición de "gestionado"**: `estaGestionadoHoy` (`segPulso.ts`). El hero y el panel
  del turno llegaron a decir "9 de 32" y "21 de 32" a la vez por tener dos. En el mapa de
  Seguimiento `ultimoResult` guarda el **método** ("Envié la guía", "No contestó"), no
  `conf/canc/noresp`.

### Frescura del dato: `last_movement_at` vs `last_synced_at`

Son preguntas DISTINTAS y confundirlas ya costó:

- **`last_movement_at`** = cuándo se movió el pedido en Dropi. **Se pisaba con NULL**: el mapper
  manda `updatedAt || null` y la RPC hacía `= EXCLUDED...` sin COALESCE, con el guard
  `IS DISTINCT FROM` como gatillo. Resultado medido: 46 de 228 pedidos vivos sin fecha → fuera de
  `estaDetenido`, fuera de las listas de estancados, al fondo del orden. Arreglado en
  `20260821180000` (dos líneas, sobre el `pg_get_functiondef` de la función viva). **No repara el
  histórico**: se recupera refrescando desde Dropi. La tarjeta ahora dice **"sin dato"** en la cara.
- **`last_synced_at`** (`20260821210000`) = cuándo Guardian MIRÓ el pedido. No existía. Lo estampa
  `_shared/marcarLeidos.ts` desde `dropi-cron` (UPDATE aparte, **no** dentro de la RPC — REGLA #1,
  y además la RPC solo escribe si algo cambió, que es justo el caso que no interesa). Re-estampa
  como mucho cada 6 h. **El histórico queda en NULL a propósito**: los que sigan en NULL son la
  lista de "pedidos que ninguna ventana de refresco alcanza".
- **La auditoría de paridad ya NO estampa hora local** en `last_movement_at`: afirmaba "se movió
  hoy" con datos sin fecha, pintaba de verde pedidos parados hace semanas y los sacaba de la
  repesca del nightly 10 días.
- **⛔ `orders.created_at` NO es la hora en que el cliente hizo el pedido** — es la hora en que
  el cron lo INSERTÓ, y va en UTC. Guardian **no guarda la hora de creación en ningún lado**:
  `orders.fecha` es solo fecha. Medido el 21-ago-2026 contra `order_created_at` de ImporChat
  (hora local EC) sobre 994 pedidos: mediana +5,15 h (= UTC−5 puro, o sea ~9 min de lag real),
  pero **p75 +9,35 h y cola hasta +120 h**. Consecuencia práctica: **cualquier análisis por
  franja horaria hecho con `created_at` sale corrido 5 h**, y encima con una cola sucia de
  pedidos que el cron trajo días después. Ya produjo una conclusión falsa ("la franja de la
  noche cancela 48%" → con hora real, dentro del turno 26,8% vs fuera 29,1%). Para hora real
  en EC hay que ir a ImporChat; ver la memoria `cancelaciones_agosto_el_boton`.
- **Pedidos con `estado IS NULL`**: `.not('estado','eq','X')` los descarta (`NOT (NULL='X')` es
  NULL). `useDataLoader` los trae con una query aparte. Medido: 0 hoy — es defensa, no reparación.

### Listas SLA en `/seguimiento` (`src/lib/segLists.ts`)

Selector de listas pre-clasificadas estilo Boostec. Cada lista tiene un predicado puro `(o: OrderData) => boolean` que combina `estado` + `días hábiles desde creación` (vía `calcBusinessDays`). Las listas de FASE son **disjuntas** — una orden NO puede aparecer en 2 a la vez (ej. `pendientes_guia` requiere `dias < 4`, `indem_pendientes_guia_4d` requiere `dias >= 4`).

**`detenidos_3d` es la excepción deliberada** (1-ago-2026): mira el RELOJ (`estaDetenido` de `segPulso.ts`, +72 h sin `last_movement_at`), no la fase, así que ATRAVIESA las columnas — un pedido parado en Reparto sale en su fase Y en detenidos. Es su razón de ser: el tablero está organizado por fase y un detenido en Reparto y otro en Oficina viven en columnas distintas, así que nadie los ve juntos. Excluye los terminales (un CANCELADO quieto no está trabado, está terminado).

**`agencia_2d` es la segunda lista de RELOJ** (14-ago-2026, nacida de la auditoría de devoluciones julio-EC): fase `oficina` + 48 h sin movimiento = paquete esperando al cliente en la agencia. La transportadora lo retiene ~7 días y lo devuelve — en julio EC fueron 76 devoluciones ($2.316). Protocolo: día 2 recordatorio, día 5 llamada. Sin `last_movement_at` NO matchea (no saber ≠ vencido). Se cruza con `en_oficina` (columna) y con `detenidos_3d` a propósito.

**El hero de Seguimiento mide la COLA DE HOY, no todo lo cargado** (14-ago-2026): sin lista activa, "por gestionar hoy" = `esAccionable()` (unión de `ACTIONABLE_SEG_SLUGS` — la misma población del guard de inactividad). Antes decía "150 por gestionar" con 120 viajando: meta imposible que la operadora ignoraba. La regla del dueño es "Seguimiento se deja en 0" y eso solo tiene sentido sobre lo accionable; el total en ruta queda como nota ("· N en ruta en total"). El aviso "Nadie ha tocado Seguimiento hoy" solo grita en amarillo de 9 a 21 h.

**No todas las listas se dibujan como chip.** `seMuestraComoChip()` oculta las que ESPEJAN una columna del tablero (`en_oficina`, `en_transito`, `en_reparto_novedad`, `guia_generada`, `pendientes_guia`, `otros_estados`) — el dueño lo señaló: "En tránsito 72" en el chip y "72 EN TRÁNSITO" en la columna de abajo era el mismo dato dos veces. **Su definición NO se borra**: `ACTIONABLE_SEG_SLUGS` las usa para el guard de inactividad, y borrarlas haría creer al sistema que no hay trabajo mientras 35 clientes esperan en una oficina. Visibles quedan solo las que el tablero no puede decir: qué está vencido o parado.

**`devolucion_reciente` es la tercera lista de RELOJ** (14-ago-2026, auditoría "devoluciones
invisibles" fa210631): fases `devolucion`/`devolucion_transito` con último movimiento ≤30 días.
Es la ÚNICA lista eximida del guard terminal de `SEG_LISTS` (`LISTAS_DE_TERMINALES`) — su trabajo
ES el terminal. NO es accionable (la llamada de rescate se hace una vez, no se exige a diario).
Las devoluciones entran a la data por una **segunda query acotada en `useDataLoader`**
(`.in('estado', ['DEVOLUCION','DEVOLUCION EN TRANSITO'])` + `last_movement_at ≥ 30d`) — la query
principal las excluye con match exacto porque NO tiene ventana de fecha; sin ese filtro entraría
el histórico completo. El hero descuenta las devoluciones de "en ruta", y `useChangeAlerts`
(que era código muerto) quedó montado en SeguimientoTab como banner "Nuevos: N devoluciones".

Slugs: `pendientes_confirmacion_2d` (link a `/confirmar`), `detenidos_3d`, `agencia_2d`, `devolucion_reciente`, `en_oficina`, `en_reparto_novedad`, `en_transito`, `guia_generada`, `indem_guia_generada_5d`, `pendientes_guia`, `indem_pendientes_guia_4d`, `otros_estados`.

Si `OrderData.fecha` está malformada, `diasDesdeCreacion()` cae a `o.dias` como fallback (try/catch).

### Productividad operadora: jornada + cobertura del día

Dos sistemas independientes, ambos client-side-light + server-state-authoritative:

**1. Jornada (heartbeat de actividad).** Hook `src/hooks/useOperatorHeartbeat.ts` montado una sola vez en `ProtectedLayoutInner` (después de los providers). Listeners de `mousemove` (throttled 1s), `keydown`, `touchstart`, `click`, `wheel`. Tick interno cada 1s acumula en buckets `activeSecondsRef` / `idleSecondsRef` según si la última actividad cae dentro de `IDLE_THRESHOLD_MS = 5 * 60 * 1000`. Cada 60s flushea vía `record_operator_heartbeat` (cap defensivo de 120s por bucket en el server). **Gates obligatorios:** `!authLoading && !isAdmin && activeStoreId`. **No usa `visibilitychange`** — confiamos en que mousemove no se dispara con la tab en background, así el idle sube natural. La sección "Jornada" del dashboard sale de `operator_activity_stats` y excluye admins server-side (migration `20260528210000`).

**2. Cobertura del día por operadora.** `OrderContext` mantiene dos `Set<string>`:
- `myConfirmTouchedToday: Set<order_id>` — pedidos donde YO inserté `order_results` con `module='confirmar'` hoy (Bogotá).
- `mySegTouchedToday: Set<phone>` — pedidos donde YO inserté `touchpoints` con `action ILIKE 'SEG:%'` hoy. `touchpoints` no tiene `order_id`, el match con `segData` es por phone (mismo patrón que `classifySegOwnershipFromTps` en `segOwnership.ts`).

Carga inicial: query barato (solo `order_id` / `phone`) filtrado por `operator_id=me` + `created_at >= startOfTodayBogota`. **Realtime:** un único canal `my-coverage-${user.id}` suscrito a INSERT en ambas tablas con `filter: operator_id=eq.${user.id}` (Postgres Realtime NO soporta ILIKE — el match de `module='confirmar'` / `action LIKE 'SEG:%'` se hace client-side en el handler). El payload de Realtime trae la fila completa → cero queries extra.

Estos sets alimentan los chips "Tu cola hoy" en `ConfirmarTab.tsx` y `SeguimientoTab.tsx` (toggle "Solo sin tocar" filtra `workQueue` / `feedBase` antes de pasar al `<WorkList>` / `<CrmTable>`). El chip de Confirmar usa `myConfirmTouchedToday.size` como "Has llamado a X"; el de Seguimiento cruza por phone contra la lista SLA activa.

**Por qué dos métricas N/R en el dashboard ("Intentos N/R" vs "N/R abiertos"):** el filtro `NOT EXISTS conf/canc posterior` de la v3 (líneas 73-81 de `20260526140000`) descuenta de `noresp` cualquier pedido que después se cerró. Esto está bien para el estado actual del pedido, pero esconde el ESFUERZO de la operadora ("llamé a 5 que no contestaron y volví a llamarlos hasta que confirmaron"). `intentos_noresp` (v4, `20260528220000`) sí cuenta esos. NO mezclar: "N/R abiertos = pedidos sin cerrar"; "Intentos N/R = llamadas que no contestaron al primer intento".

### Address Validator (validador de direcciones)

When a pending order is rendered in `CallView` / `CrmCallView`, the system runs a multi-layered validation pipeline. Touching this is fragile — read this section before changing anything.

> **ESTADO (2026-08-04): Google APAGADO, ahora de verdad.** Con `GOOGLE_PLACES_ENABLED = false` el paso 1 cortocircuita en `CallView`/`CrmCallView` y el semáforo corre sobre la heurística local (pasos 2–4).
>
> **Lo que este párrafo daba por hecho y era falso hasta hoy:** que "no edge call" valía para TODA la pantalla. El `AddressValidationBadge` que se dibuja en estas mismas vistas usa `useAddressValidation`, y ese hook llamaba a `dropi-validate-address` sin mirar el flag — más de dos meses pagando Google y Haiku sin que se notara. Arreglado en `99d07a3`; el servidor quedó además con su propio candado (`GOOGLE_ENABLED`, cerrado por defecto) y hay una prueba (`src/test/googleApagado.test.ts`) que falla si alguien vuelve a llamar a esas funciones sin preguntar por el flag.

**Decision states** (`validation_decision` column): `green` · `yellow` · `red` · `pickup_office` · `null`. Drives the colored badge and the `DespachoGateButton` enable/disable state via `src/lib/canConfirmOrder.ts` (gate spec lives in its `.test.ts`).

**Pipeline order** (auto-validate effect in `CallView.tsx` and `CrmCallView.tsx`):
1. Edge function `dropi-validate-address` (Google Places + Haiku optional). Times out at 3s → fires heuristic fallback in parallel without cancelling.
2. Heuristic-only fallback (`src/lib/addressHeuristic.ts` + `src/lib/mapAddressKind.ts`). Pure regex, no network. Always writable.
3. Hard stop at 10s — if `dbWritten === false`, force-runs the heuristic again as last-resort. Card NEVER terminates in "Sin validar" except when address < 5 chars.
4. Two module-level `Set<string>` overrides re-evaluate stale rows on each render: pickup detection (`pickupOverrideAppliedIds`) and stale-green correction (`staleGreenOverrideIds`). They write DB but never call the edge function (no Google quota burn).

**Visual override** (`visualDecision` IIFE in CallView): displays the client-side decision immediately so the operator doesn't see a flash of stale DB green/yellow before realtime catches up. The `DespachoGateButton` reads `visualDecision`, NOT `o.validationDecision`.

**Anti-hallucination guard** — `src/lib/locationGuard.ts` `locationMatches(text, ciudad?, departamento?)`. Required before showing ANY external suggestion (Google, Haiku, edge-function cache). If the order has a `ciudad` ≥3 chars, the suggestion text MUST contain it; matching by departamento alone is REJECTED (Neiva and Pitalito are both in Huila but 200 km apart). Used in `useGoogleAddressLookup`, `googleSuggestions` cache, `suggestedAddress` prop. NEVER show external text without passing it through this guard.

**Heuristic gotchas** (`addressHeuristic.ts`):
- Score capped at 65 (yellow) when `CANONICAL_PLACA_REGEX` doesn't match — i.e. without an explicit `# X-Y` hyphen, can't reach green.
- `COMPLEMENT_NO_NUMBER` regex catches "Apartamento." with no number after, also caps at 65.
- Input is NFD-normalized to strip accents BEFORE regex, so "Callé" matches "Calle".
- `mapAddressKind` returns `'pickup_office'` for "of interrapidismo", "Reclamo en oficina", "pasaje comercial", "centro comercial", "lo recojo yo", etc.

**Client-side suggestion builder** (`src/lib/buildAddressSuggestion.ts`): pure heuristic, NEVER invents data — only re-formats what the customer already wrote (direccion + ciudad + departamento + barrio). Output `{ suggested, missingNote, hasEnoughInfo }`. Uses preposition "en" instead of `___` placeholders when info is partial. Goes through `locationMatches` sanity check before render.

**Pending migration:** `supabase/migrations/20260502000000_add_suggested_address.sql` adds `orders.suggested_address` column. Until applied, `src/lib/orderColumns.ts` and the UPDATEs in `CallView.tsx`/`CrmCallView.tsx` reference it via commented `HOTFIX 2026-04-30` lines. Re-enable when migration runs.

### Convención `docs/superpowers/`

`specs/*-design.md` (documentos de diseño fechados: contexto, tabla de decisiones, arquitectura,
zonas de riesgo, fuera-de-alcance) alimentan `plans/*.md` (planes de implementación fechados, tarea
por tarea, con casillas `- [ ]`, tabla de archivos a crear/modificar y verificación por tarea).

**Trampa:** los encabezados de los planes exigen una sub-skill `superpowers:*` que **no está
instalada en este entorno** (no hay `.claude/skills/` ni plugin). Son artefactos de un setup
anterior: hay que seguir la convención a mano. Y como muestra el plan del rediseño 3D, **el estado
de las casillas puede mentir** — verificar contra el código, nunca contra el checkbox.

### Capa `ui3d` — primitivas de presentación (rediseño "3D command center")

`src/components/ui3d/` (`TiltCard`, `CountUp`, `GaugeRing`, `Sparkline`, `StatTile`, `RankRow`,
`StackedDayBars`, `AuroraBackdrop`, `IconRail`, `HudTopbar` + hooks `useTilt`/`useCountUp`, con
barrel `index.ts`). `ProtectedLayout` ya monta `IconRail`, `HudTopbar` y `AuroraBackdrop`.

**⛔ TODO QUIETO (23-ago-2026, pedido del dueño):** `TiltCard` ya NO se inclina con el mouse
ni renderiza el sheen (se apagó en la RAÍZ del componente, no card por card — la prop `sheen`
quedó inerte para no tocar 50+ call-sites) y los blobs de `AuroraBackdrop` no flotan. No
reintroducir tilt/sheen/loops sin pedido explícito. Los hover de SOLO color y los fadeUp de
entrada sí se conservan.

Contrato duro — respetarlo al agregar pantallas:
- **Solo reciben `number` / `string` / `ReactNode`.** Nunca hooks de datos, queries ni el cliente
  de Supabase. Ninguna pantalla reimplementa tilt/count-up/gauge por su cuenta.
- **Nada nuevo usa `backdrop-filter`** — es deliberado: `bg-card/40` sobre la aurora da
  profundidad sin matar el scroll de un `CrmTable` de 100 filas. Los `.glass-panel` de
  `ConfirmarTab`/`AuthPage` son preexistentes y están grandfathered.
- La decisión de desactivar el tilt (táctil, mobile, `prefers-reduced-motion`) vive **solo** en
  `useTilt`. Los alfas de `AuroraBackdrop` están calibrados de contraste **a través** de las
  tarjetas translúcidas — subirlos obliga a re-chequear contraste sobre la tarjeta, no sobre el
  fondo desnudo.

Estado del rediseño: el spec (`docs/superpowers/specs/2026-07-18-rediseno-3d-command-center-design.md`)
planea 10 tandas (0–9), un commit cada una, en `redesign/3d-command-center`. El plan
`plans/2026-07-18-rediseno-3d-tandas-0-2.md` cubre solo las tandas 0–2 y tiene **82 casillas sin
marcar y 0 marcadas, pero el código ya está puesto** — las casillas están desactualizadas, no
pendientes. Las tandas 3–9 no tienen archivo de plan. El propio spec advierte: **"No usar el git
log como fuente de estado"** (commits anteriores prometieron más cobertura de la que entregaron) y
marca la **tanda 4 (`CallView`/`CrmCallView`) como la peligrosa** — toca los overrides
module-level de validación de direcciones, `visualDecision` y `DespachoGateButton`; si aparece un
`visualDecision` o un efecto de auto-validación en el diff, revertir.
