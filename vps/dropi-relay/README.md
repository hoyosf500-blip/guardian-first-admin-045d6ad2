# dropi-relay (VPS) — proxy de egress con IP fija hacia Dropi

Proxy que hace que las llamadas a la **API oficial de Dropi** (`/integrations/*`) salgan
siempre desde la **IP fija** del VPS (`2.25.69.238`), que Dropi tiene en su lista blanca.
Resuelve el problema de que las edge functions de Supabase egresan por IPs que rotan.

> **No confundir** con `supabase/functions/dropi-relay` (ese es INBOUND: le presta la IP
> de Supabase a un tercero externo). Este es OUTBOUND para nuestras propias llamadas.

## Dónde corre

- **VPS:** Hostinger `srv1784684.hstgr.cloud` (Ubuntu 24.04, IPv4 `2.25.69.238`).
- **Contenedor:** `dropi-relay` (`denoland/deno:alpine`, `restart: always`), en la red
  Docker `evolution_default` (la del stack del bot de WhatsApp). Escucha en `:8081`
  **solo dentro** de la red Docker (no expuesto al host).
- **Ruta pública:** Caddy (`/opt/evolution/Caddyfile`) enruta
  `https://srv1784684.hstgr.cloud/dropi/*` → `dropi-relay:8081` con HTTPS automático.
- **Archivos en el VPS:** `/opt/dropi-relay/` (`relay.ts`, `docker-compose.yml`, `.env`).

## Contrato

```
GET  /dropi/health
  -> { ok, service:"dropi-relay", egress_ip:"2.25.69.238", ts }

POST /dropi/proxy              (header  x-relay-secret: <RELAY_SECRET>)
  body: { base?, endpoint, method?, query?, body?, token }
    base    default "https://api.dropi.co"  (DEBE ser un dominio de Dropi; si no -> 400)
    endpoint  ej "orders/myorders"  -> se le antepone "/integrations/"
    method    GET|POST|PUT|PATCH|DELETE   (otro -> 405)
    token     -> se manda como header  dropi-integration-key
  -> { ok, status, data, target, duration_ms }
```

Endurecido: allowlist de host destino (solo dominios de Dropi → mata SSRF/proxy abierto),
timeout upstream de 30s (→ 504), allowlist de método, log estructurado sin secretos,
health con IP de egress cacheada. Auth por `x-relay-secret`.

## Desplegar / actualizar

Copiar `relay.ts` (y si cambió, `docker-compose.yml`) a `/opt/dropi-relay/` en el VPS y:

```bash
cd /opt/dropi-relay
docker compose up -d      # recrea el contenedor con el relay.ts nuevo
docker logs dropi-relay --tail 20
```

El `.env` (en el VPS, perms 600) tiene `RELAY_SECRET=<hex 32 bytes>`. Ese mismo secreto
va a los secrets de Supabase de Guardian cuando se cablee el ruteo (Fase B): como
`DROPI_PROXY_SECRET`, junto con `DROPI_PROXY_URL=https://srv1784684.hstgr.cloud/dropi/proxy`.

## Probar

```bash
curl -s https://srv1784684.hstgr.cloud/dropi/health
# egress_ip debe ser 2.25.69.238

curl -s -X POST https://srv1784684.hstgr.cloud/dropi/proxy \
  -H "x-relay-secret: $SECRET" -H "content-type: application/json" \
  -d '{"base":"https://test-api.dropi.co","endpoint":"helpers/validateToken","method":"GET","token":"<token>"}'
# base fuera de Dropi -> 400 ; sin secret -> 401
```
