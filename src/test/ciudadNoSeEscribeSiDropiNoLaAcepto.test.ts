// PRUEBA GUARDIANA — la ciudad editada desde el CRM no puede mentir.
//
// Lo que reportó el operador de Ecuador (4-sep-2026): *"el cambio de ciudad,
// en el CRM aunque le cambie no se logra actualizar, y lo hago mediante
// Dropi"*. Era cierto: el PUT de integración de Dropi devuelve 200 y conserva
// la ciudad vieja; la edge escribía la ciudad NUEVA en la ficha local igual,
// y el cron (upsert: `ciudad = EXCLUDED.ciudad`) la revertía en ≤20 min. El
// segundo intento ni tocaba Dropi porque `nothingChanged` comparaba contra la
// fila local, que ya decía la ciudad nueva. Medido en producción: de 12
// cambios de ciudad desde agosto, 2 revertidos y el resto salvados a mano
// recreando el pedido (lo que el equipo llama "se duplican").
//
// Esta prueba lee los archivos y falla si alguien vuelve a:
//  - escribir `ciudad` en la ficha local sin condicionarlo a que Dropi la
//    haya aceptado (`destino.stale`);
//  - verificar el destino DESPUÉS del UPDATE local (tiene que ir antes);
//  - rendirse sin intentar el canal web del panel (el que usa la asesora);
//  - llamar a la edge desde el editor sin `storeId` (dos empresas comparten
//    número de pedido desde 20260820140000);
//  - seguir con transportadora/valor cuando la ciudad no entró (el editor
//    recrearía el pedido con la ciudad vieja).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const EDGE = readFileSync(resolve(ROOT, 'supabase/functions/dropi-update-order-full/index.ts'), 'utf8');
const EDITOR = readFileSync(resolve(ROOT, 'src/components/confirmar/OrderEditorDialog.tsx'), 'utf8');

describe('dropi-update-order-full: la ciudad no se escribe si Dropi no la aceptó', () => {
  it('el UPDATE local condiciona ciudad/departamento a que el destino NO esté viejo', () => {
    expect(EDGE).toMatch(/\.\.\.\(destino\.stale \? \{\} : \{ ciudad, departamento \}\)/);
    // y no queda ninguna escritura incondicional de la ciudad en el update
    expect(EDGE).not.toMatch(/\n\s+ciudad, departamento, direccion,\n/);
  });

  it('lee el destino en Dropi ANTES del UPDATE local', () => {
    const lectura = EDGE.indexOf('destino = await leerDestinoEnDropi(');
    const update = EDGE.indexOf('const localUpdate = sbAdmin');
    expect(lectura).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(0);
    expect(lectura).toBeLessThan(update);
  });

  it('si la ciudad no entró, la intenta por el canal web antes de rendirse', () => {
    const i = EDGE.indexOf('if (destino.stale) {');
    expect(i).toBeGreaterThan(0);
    const bloque = EDGE.slice(i, i + 900);
    expect(bloque).toContain('/api/orders/myorders/');
    expect(bloque).toContain('method: "PUT", body: webPayload');
    expect(bloque).toContain('destino = await leerDestinoEnDropi(');
  });

  it('refresca la sesión web antes de leer (un v2 con token vencido se callaba)', () => {
    const i = EDGE.indexOf('destino = await leerDestinoEnDropi(');
    const antes = EDGE.slice(Math.max(0, i - 400), i);
    expect(antes).toContain('ensureSessionUsable(sbAdmin, cfg)');
  });

  it('la respuesta dice destStale y no afirma nada cuando no pudo leer', () => {
    expect(EDGE).toContain('destStale: true');
    expect(EDGE).toContain('destinoSinVerificar: true');
  });
});

const CARRIER = readFileSync(resolve(ROOT, 'supabase/functions/dropi-change-carrier/index.ts'), 'utf8');
const PLAN = readFileSync(resolve(ROOT, 'src/lib/orderEditPlan.ts'), 'utf8');

describe('la ciudad se cambia RECREANDO el pedido, como la web de Dropi (4-sep-2026)', () => {
  // El PUT /orders/myorders/{id} de Dropi no lleva ciudad: su propia web, al
  // cambiarla, llama createOrder (id nuevo, vieja REEMPLAZADA). Probado en
  // producción sobre #6855164: PUT integración 200 + PUT web 200 y la ciudad
  // siguió igual. El único camino real es la recreación.
  it('el plan manda un cambio de ciudad a apply_edit', () => {
    expect(PLAN).toMatch(/if \(f\.carrierChanged \|\| f\.linesChanged \|\| f\.destinoChanged\) steps\.push\('apply_edit'\)/);
  });

  it('el editor manda ciudad/departamento nuevos en el body de apply_edit', () => {
    const i = EDITOR.indexOf("mode: 'apply_edit'");
    expect(i).toBeGreaterThan(0);
    expect(EDITOR.slice(i, i + 700)).toContain('ciudad: form.ciudad.trim(), departamento: form.departamento.trim()');
  });

  it('el PUT (update_full) NO lleva la ciudad nueva cuando esta viaja por la recreación', () => {
    expect(EDITOR).toContain('const ciudadPut = destinoPorRecreacion ? initial.ciudad : form.ciudad.trim();');
    const i = EDITOR.indexOf("supabase.functions.invoke('dropi-update-order-full'");
    expect(EDITOR.slice(i, i + 900)).toContain('ciudad: ciudadPut,');
  });

  it('la edge recrea en el destino que manda el editor y escribe ese destino en la ficha nueva', () => {
    expect(CARRIER).toContain('const cityE = String(body.ciudad || "").trim() || clientE.city;');
    expect(CARRIER).toContain('resolveDestCity(sbAdmin, cfg, cfg.countryCode, cityE, stateE)');
    expect(CARRIER).not.toMatch(/resolveDestCity\(sbAdmin, cfg, cfg\.countryCode, clientE\.city, clientE\.state\)/);
    const i = CARRIER.indexOf('external_id: newIdE,');
    expect(CARRIER.slice(i, i + 500)).toContain('ciudad: ctxE.dest.cityName');
  });
});

describe('OrderEditorDialog: el editor no da por guardada una ciudad que Dropi no tomó', () => {
  it('manda storeId a dropi-update-order-full', () => {
    const i = EDITOR.indexOf("supabase.functions.invoke('dropi-update-order-full'");
    expect(i).toBeGreaterThan(0);
    expect(EDITOR.slice(i, i + 600)).toContain('storeId: activeStoreId');
  });

  it('con destStale corta el plan (return false) y deja la ciudad sucia para reintentar', () => {
    const i = EDITOR.indexOf('if (d?.destStale && d?.warning) {');
    expect(i).toBeGreaterThan(0);
    // Solo el cuerpo del `if` (hasta su llave de cierre), no lo que sigue.
    const bloque = EDITOR.slice(i, EDITOR.indexOf('\n    }\n', i));
    expect(bloque).toContain('return false;');
    expect(bloque).toContain('ciudad: initial.ciudad, departamento: initial.departamento');
    expect(bloque).not.toContain('return true;');
  });
});
