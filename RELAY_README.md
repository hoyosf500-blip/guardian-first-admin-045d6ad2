# Dropi Relay — Proxy HTTP autenticado

Este proyecto expone un endpoint relay que permite a sistemas externos ejecutar
requests a la API de Dropi a través de la infraestructura de Supabase Edge
Functions de **este** proyecto. Útil cuando el JWT de Rushmira tiene IP
whitelisting (`ip_url` claim) y el sistema cliente corre en infraestructura con
IPs no autorizadas.

> **No almacena tokens ni datos.** Solo proxea HTTP request → response.

---

## 📋 Datos para compartir con tu amiga

Pasale estos 3 datos por canal seguro (Signal / 1Password / similar — **no por chat público**):

| Dato | Valor |
|---|---|
| **URL del relay** | `https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-relay` |
| **RELAY_SHARED_SECRET** | _(guardado como secret en Lovable Cloud — recuperalo desde el panel de secrets y pasaselo aparte)_ |
| **IP de egress** | `63.177.86.18` _(eu-central-1, AWS Frankfurt — ver nota abajo)_ |

### ⚠️ Nota sobre la IP de egress

Supabase Edge Functions corren sobre AWS y la IP de salida **puede rotar** dentro
del rango de eu-central-1. Si Rushmira/Dropi exige IP fija para el `ip_url`
claim, hay tres caminos:

1. Pedir a Rushmira que whiteliste el rango completo de AWS eu-central-1 (poco
   práctico).
2. Re-verificar la IP cada cierto tiempo con `GET /egress-ip` y mantenerla
   actualizada en el whitelist.
3. Mover el relay a un VPS con IP fija (Hostinger / Contabo / etc.) — solución
   definitiva si la rotación es un problema.

Para verificar la IP actual en cualquier momento:

```bash
curl https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-relay/egress-ip
```

---

## 🔌 Endpoints

### `GET /dropi-relay/health`

Healthcheck. Sin auth.

```bash
curl https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-relay/health
# → { "ok": true, "ts": "2026-04-17T..." }
```

### `GET /dropi-relay/egress-ip`

Devuelve la IP pública desde la cual el relay hace requests salientes
(la que Dropi va a ver). Sin auth.

```bash
curl https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-relay/egress-ip
# → { "ok": true, "ip": "63.177.86.18", "ts": "..." }
```

### `POST /dropi-relay`

Proxy a Dropi. Requiere header `x-relay-secret`.

**Headers:**

```
Content-Type: application/json
x-relay-secret: <RELAY_SHARED_SECRET>
```

**Body:**

```json
{
  "dropi_token": "<JWT de Rushmira>",
  "country": "CO",
  "endpoint": "orders/myorders",
  "page": 1,
  "page_size": 100,
  "date_from": "2026-01-01",
  "date_to": "2026-04-16"
}
```

**Países soportados:** `CO`, `MX`, `EC`, `CL`, `PE`, `PA`, `AR`, `GT`, `PY`,
`VE`, `BO`, `CR`, `ES`.

**Response (éxito):**

```json
{
  "ok": true,
  "status": 200,
  "data": { /* JSON crudo de Dropi, sin remapear */ },
  "diagnostics": {
    "egress_ip": "63.177.86.18",
    "requested_url": "https://api.dropi.co/integrations/orders/myorders?...",
    "country": "CO",
    "duration_ms": 1234,
    "jwt": { "iss": "...", "aud": "...", "integration_type": "...", "integration_url": "...", "ip_url": [...] }
  }
}
```

**Response (error):**

```json
{
  "ok": false,
  "status": 403,
  "error": "...",
  "data": { /* lo que devolvió Dropi, si algo */ },
  "diagnostics": { /* idem */ }
}
```

---

## 🧪 Ejemplo curl completo

```bash
curl -X POST https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-relay \
  -H "Content-Type: application/json" \
  -H "x-relay-secret: <RELAY_SHARED_SECRET>" \
  -d '{
    "dropi_token": "<JWT_DE_RUSHMIRA>",
    "country": "CO",
    "endpoint": "orders/myorders",
    "page": 1,
    "page_size": 10,
    "date_from": "2026-01-01",
    "date_to": "2026-04-16"
  }'
```

---

## 🔒 Seguridad

- **Auth:** shared secret (`x-relay-secret`). Sin auth de Supabase
  (`verify_jwt = false`) porque el cliente externo no tiene sesión en este
  proyecto.
- **No persistencia:** el relay no escribe nada en DB. Solo hace fetch y
  devuelve la respuesta.
- **JWT del cliente:** el token de Dropi viaja en el body (POST sobre HTTPS).
  Se loggean los claims para diagnóstico (iss, aud, ip_url, integration_url),
  **nunca el token completo**.
- **Rotación del secret:** si alguna vez se filtra, regenerá
  `RELAY_SHARED_SECRET` en los secrets de Lovable Cloud y pasale el nuevo a
  tu amiga.

---

## 🏗️ Arquitectura

```
┌──────────────────────┐         ┌──────────────────────────┐         ┌────────────┐
│ Proyecto de tu amiga │ HTTPS   │  Este proyecto           │ HTTPS   │ Dropi API  │
│ (Lovable + Supabase) │ ──────▶ │  /functions/v1/          │ ──────▶ │ api.dropi  │
│                      │ x-relay-│  dropi-relay             │ Origin: │ .{co|mx..} │
│                      │ secret  │  (egress 63.177.86.18)   │ rushmir │            │
└──────────────────────┘         └──────────────────────────┘         └────────────┘
```

El relay no toca tu integración existente con Dropi (`dropi-sync`, `dropi-update-order`, etc.).
Es una function aislada (`dropi-relay`) que solo proxea.
