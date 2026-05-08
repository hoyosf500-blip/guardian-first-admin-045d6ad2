# Clonar el CRM para un cliente nuevo

Esta guía describe los pasos para levantar una instancia limpia del CRM
para un operador externo (single-tenant: un Supabase + un Lovable por
cliente).

## Prerrequisitos

- Cuenta en Supabase (https://supabase.com).
- Cuenta en Lovable (o Vercel/Netlify si querés deploy externo).
- Node 20+ y `npm` localmente para verificar el build.
- CLI de Supabase: `npm i -g supabase`.

## 1) Crear proyecto Supabase

1. https://supabase.com → New project. Región sugerida: la más cercana
   al cliente.
2. Una vez listo, anotá:
   - **Project URL** (Settings → API → Project URL).
   - **anon / public key** (Settings → API → Project API keys).

## 2) Clonar el repo

```bash
git clone <url-del-repo> cliente-crm
cd cliente-crm
npm install
```

## 3) Configurar variables de entorno

```bash
cp .env.example .env
```

Editá `.env`:

```
VITE_SUPABASE_URL=https://<tu-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon-key>
# VITE_ENABLE_CFO=true     # NO descomentar para clientes
```

> El módulo `/cfo` solo se activa para la instancia del dueño original.
> Para un cliente externo, **dejá `VITE_ENABLE_CFO` comentado** — la
> ruta no se registrará y `/cfo` devolverá 404.

## 4) Aplicar migraciones a la nueva base

```bash
supabase login
supabase link --project-ref <tu-ref-de-supabase>
supabase db push
```

Esto aplica todas las migraciones de `supabase/migrations/` en orden.
La migración `20260508_*_sanitize_for_clone.sql` (la última) garantiza
que la base nueva arranque limpia:

- Vacía `dropi_white_brand_id` si trae el valor del seed original.
- Crea `brand_name`, `brand_logo_url`, `dropi_store_url`,
  `dropi_session_token` vacíos para el wizard.
- Borra el seed de bitácora financiera Q1 2026 (datos del dueño
  original) — solo se ejecuta si `is_seed_data_owner != 'true'`.

## 5) Deployar las edge functions

```bash
supabase functions deploy dropi-sync
supabase functions deploy dropi-update-order
supabase functions deploy dropi-update-order-full
supabase functions deploy dropi-resolve-incidence
supabase functions deploy dropi-fingerprint
supabase functions deploy dropi-cron
supabase functions deploy dropi-relay
supabase functions deploy dropi-validate-address
supabase functions deploy dropi-wallet-sync
supabase functions deploy ai-order-assistant
supabase functions deploy google-places-proxy
supabase functions deploy parse-bank-pdf-text
```

(Estas funciones leen tokens desde `app_settings` en runtime — el
wizard del paso 7 las llena.)

## 6) Deploy del frontend

**Lovable:** Connect repo → New project → seleccioná el repo.
**Vercel/Netlify:** importar repo, framework Vite, build `npm run
build`, output `dist`.

Verificá que el sitio cargue y muestre la pantalla de login.

## 7) Crear el primer admin y completar el wizard

1. Registrate como primer usuario en `/auth`.
2. Asignate rol admin manualmente:

   ```sql
   -- En Supabase SQL Editor:
   INSERT INTO public.user_roles (user_id, role)
   VALUES ('<tu-uuid>', 'admin');
   ```

3. Refrescá. Vas a ver el **Setup Wizard** bloqueando el resto del CRM.
4. Completá:
   - Nombre del negocio (aparece en sidebar).
   - API Key Dropi (Bearer permanente).
   - Token de sesión Dropi (JWT, vence cada ~12-24h).
   - White Brand ID (hash de tu marca en Dropi).
   - URL de tu tienda Dropi.
   - Logo URL (opcional).
5. Guardar y continuar — el sidebar ahora muestra tu marca.

## Troubleshooting

- **El wizard no aparece:** asegurate de tener rol `admin` en
  `user_roles`. Operadoras ven todo el CRM con valores por defecto si
  el admin aún no completó el setup.
- **`column X does not exist` al cargar pedidos:** alguna migración no
  corrió. `supabase db push` y verificá que termine OK.
- **`/cfo` se ve aunque no debería:** `VITE_ENABLE_CFO` quedó como
  `true` en `.env`. Comentar y rebuild.
- **Edge function devuelve 401/403 a operadoras:** las funciones que
  modifican pedidos exigen rol admin. Operadoras deben usar la UI, no
  llamar a las edge functions directo.
- **Tokens Dropi vencidos:** el `dropi_session_token` (JWT) vence cada
  ~12-24h. Refrescarlo desde DevTools → Network → header
  `x-authorization` en cualquier request a `api.dropi.co`. Editar en
  `/admin → Huella del comprador`.

## Verificación final

- [ ] `/dashboard` carga sin errores.
- [ ] `/seguimiento` muestra el dropdown "Listas SLA" con 8 opciones.
- [ ] `/rescate` devuelve 404 (eliminado del producto).
- [ ] `/cfo` devuelve 404 (no habilitado).
- [ ] El sidebar muestra el nombre del cliente, no "Guardian CRM".
- [ ] Sincronización con Dropi trae pedidos.
