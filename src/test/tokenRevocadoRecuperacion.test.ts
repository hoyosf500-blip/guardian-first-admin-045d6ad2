import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guardia: recuperarse de un session token REVOCADO por Dropi.
 *
 * Dropi revoca tokens ANTES de su fecha de vencimiento (entrar al panel desde
 * otro navegador es el caso típico). `ensureFreshSessionToken` renueva mirando
 * el `exp` del JWT, así que ante un token revocado-pero-no-vencido devuelve el
 * token MUERTO y la operación muere en 401. La asesora queda en un bucle: el
 * botón "Reintentar" manda exactamente el mismo token muerto.
 *
 * Pasó en vivo el 18-ago-2026 en Rushmira Colombia: login automático activo,
 * renovado a las 08:23, y a las 10:08 el editor de pedidos no cargaba ni los
 * productos. Nada estaba mal configurado. Peor: el mensaje de error la mandaba
 * a "configurá el login automático", que YA estaba configurado.
 *
 * El daño caro no es el editor que no abre — es que el create-with-edit salga
 * BIEN y muera el `PUT REEMPLAZADA` posterior: el pedido viejo queda vivo en
 * Dropi, el cron lo vuelve a traer, y así nace un pedido DUPLICADO.
 *
 * La defensa es `ensureSessionUsable` (_shared/dropiSessionUsable.ts): PROBAR
 * el token con una lectura barata antes de usarlo, y solo ahí forzar el
 * re-login. Nunca reintenta una mutación.
 */

const RAIZ = 'supabase/functions';
const FN = (p: string) => readFileSync(join(RAIZ, p), 'utf8');

/** Los caminos donde una persona edita un pedido. Acá el probe SÍ se paga:
 *  son operaciones raras y disparadas a mano, no un cron por tienda. */
const CAMINOS_DE_EDICION = [
  'dropi-change-carrier/index.ts',
  'dropi-update-order-full/index.ts',
];

describe('recuperación de un session token revocado por Dropi', () => {
  it('el helper compartido existe, prueba el token y fuerza el re-login', () => {
    const src = FN('_shared/dropiSessionUsable.ts');
    expect(src, 'debe forzar un re-login, no solo mirar el exp').toMatch(/force:\s*true/);
    expect(src, 'debe PROBAR el token con una lectura').toMatch(/sessionProbe/);
  });

  it('no le pide al dueño configurar algo que ya está configurado', () => {
    const src = FN('_shared/dropiSessionUsable.ts');
    // Cuando la tienda NO tiene login automático, ensureFreshSessionToken
    // devuelve el MISMO token sin tirar. Sin este chequeo el mensaje era el
    // genérico de siempre y una tienda nueva no entendía por qué, pasada una
    // hora, no puede volver a editar un pedido nunca más.
    expect(src, 'debe distinguir "sin login configurado" de "login que falla"')
      .toMatch(/anterior/);
    expect(src).toMatch(/NO tiene login automático/);
  });

  it('los caminos de EDICIÓN usan el helper y no el chequeo por fecha a secas', () => {
    for (const f of CAMINOS_DE_EDICION) {
      const src = FN(f);
      expect(src, `${f} debe usar ensureSessionUsable`).toMatch(/ensureSessionUsable\(/);
      // El probe admin de dropi-update-order-full sigue usando el chequeo por
      // fecha a propósito (es una radiografía, no una gestión). Lo que NO puede
      // pasar es que una MUTACIÓN salga con un token que nadie probó.
      const mutaConTokenSinProbar = /cfg\.sessionToken = await ensureFreshSessionToken\(sbAdmin, cfg\);/;
      expect(src, `${f} muta con un token que nadie probó`).not.toMatch(mutaConTokenSinProbar);
    }
  });

  it('ninguna mutación se reintenta — reintentar un create duplica pedidos', () => {
    const src = FN('_shared/dropiSessionUsable.ts');
    // Lo único que este módulo repite es el probe (un GET). Si alguien mete acá
    // un reintento genérico de la operación del caller, vuelve el duplicado de
    // julio-2026 (memoria dropi_lucidbot_final_order).
    expect(src).not.toMatch(/\bop\(\)|callback|reintent(ar|o) la operaci/i);
  });

  /**
   * Inventario honesto: estas funciones TAMBIÉN usan el token web y todavía no
   * saben recuperarse de una revocación. No están rotas hoy, pero cuando Dropi
   * les revoque el token fallan hasta que alguien lo note.
   *
   * No se arreglaron acá a propósito: `dropi-cron` corre por tienda y pagar un
   * probe por tienda por corrida es otra decisión, no un descuido. Si alguna se
   * migra, se saca de esta lista y la prueba de arriba la cubre.
   */
  it('deja anotado, y no en silencio, qué funciones aún no se recuperan', () => {
    const pendientes = [
      'dropi-cron/index.ts',
      'dropi-open-incidences/index.ts',
      'dropi-sync-city-catalog/index.ts',
      'shopify-push-dropi/index.ts',
    ];
    const yaMigradas = pendientes.filter((f) => /ensureSessionUsable\(/.test(FN(f)));
    expect(yaMigradas, 'migrada: sacala de la lista de pendientes').toEqual([]);
  });
});
