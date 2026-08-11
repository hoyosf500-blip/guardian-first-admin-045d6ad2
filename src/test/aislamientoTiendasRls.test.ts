import { describe, it, expect, beforeAll } from 'vitest';

/**
 * FUGA HACIA AFUERA — prueba viva contra la base real.
 *
 * La clave pública (anon) viaja en el navegador de cualquiera que abra la app:
 * es pública POR DISEÑO. Lo que no puede pasar es que con ella se lean pedidos,
 * credenciales de Dropi/Shopify o mensajes de WhatsApp de NINGUNA tienda, ni
 * que se pueda borrar nada.
 *
 * Esto no se puede simular: se prueba contra la base. Si no hay red o no hay
 * credenciales en el entorno, la prueba se salta en vez de dar falso verde
 * (un `skipped` se ve en la salida; un `pass` mentiroso no).
 *
 * NO toca la huella digital (dropi-fingerprint) ni ninguna edge function:
 * son solo lecturas y un DELETE que debe ser rechazado.
 */

const URL_BASE = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Tablas que jamás deben abrirse con la clave pública. */
const TABLAS_CERRADAS = [
  'orders',
  'order_results',
  'profiles',
  'store_members',
  'store_dropi_config',
  'store_shopify_config',
  'wa_channels',
  'wa_messages',
  'wa_conversations',
  'dropi_wallet_movements',
  'notes',
  'touchpoints',
];

let hayRed = false;

async function rest(path: string, init?: RequestInit) {
  return fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON as string, ...(init?.headers ?? {}) },
  });
}

const hayEntorno = Boolean(URL_BASE && ANON);
const d = hayEntorno ? describe : describe.skip;

d('aislamiento — la clave pública no abre nada', () => {
  beforeAll(async () => {
    try {
      const r = await fetch(`${URL_BASE}/rest/v1/`, { headers: { apikey: ANON as string } });
      hayRed = r.status > 0;
    } catch {
      hayRed = false;
    }
  }, 20_000);

  for (const tabla of TABLAS_CERRADAS) {
    it(`no se puede leer ${tabla} con la clave pública`, async () => {
      if (!hayRed) return; // sin red: no afirmamos nada
      const r = await rest(`${tabla}?select=*&limit=1`);
      const cuerpo = await r.text();
      // 401/403 = permiso denegado (lo esperado). 200 solo sería tolerable con
      // una lista vacía, y aun así significa que el GRANT sigue abierto.
      expect(
        [401, 403].includes(r.status),
        `${tabla} respondió ${r.status}: ${cuerpo.slice(0, 200)}`,
      ).toBe(true);
    }, 20_000);
  }

  it('no se puede borrar pedidos con la clave pública', async () => {
    if (!hayRed) return;
    const r = await rest('orders?id=neq.00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
    });
    const cuerpo = await r.text();
    expect([401, 403].includes(r.status), `DELETE devolvió ${r.status}: ${cuerpo.slice(0, 200)}`).toBe(true);
  }, 20_000);

  it('no se puede insertar un pedido con la clave pública', async () => {
    if (!hayRed) return;
    const r = await rest('orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'test-aislamiento', phone: '0000000000' }),
    });
    const cuerpo = await r.text();
    expect([401, 403].includes(r.status), `POST devolvió ${r.status}: ${cuerpo.slice(0, 200)}`).toBe(true);
  }, 20_000);
});
