import { describe, it, expect } from 'vitest';
import {
  elegirGemeloCiego, last9, VENTANA_GEMELO_MS, type FilaPush,
} from '../../supabase/functions/_shared/gemeloInvisible';

/**
 * Cruza el límite a `supabase/functions/_shared/` a propósito: `npm test` NO
 * corre las pruebas que viven dentro de `supabase/functions/` (vitest.config
 * solo mira `src/`), así que una prueba puesta allá no se ejecuta nunca — ni
 * acá ni en CI. Es el mismo patrón de `autoPushSelect.test.ts`.
 */

const fila = (shopify: string, phone: string, dropi: string | null = null): FilaPush => ({
  shopify_order_id: shopify, dropi_order_id: dropi, payload: { phone },
});

const TEL = '3148664637';
const T9 = last9(TEL);

describe('el gemelo que el espejo todavía no muestra', () => {
  /**
   * ⛔ EL CASO DE LA FOTO (3-sep-2026). Dos guías consecutivas para la misma
   * clienta en San Andrés. Dos ventas de Shopify, el mismo teléfono, la misma
   * corrida del robot: cuando se subió la segunda, la primera ya existía en
   * Dropi pero todavía NO en `orders` — y los tres candados que había miran
   * `orders`.
   */
  it('frena la segunda venta cuando la primera se subió hace un rato y no llegó al espejo', () => {
    const g = elegirGemeloCiego([fila('S-1', TEL, '38398872880')], T9, 'S-2', new Set());
    expect(g?.shopify_order_id).toBe('S-1');
    expect(g?.dropi_order_id).toBe('38398872880');
  });

  /**
   * ⛔ NO SE PISA LA REGLA DEL DUEÑO (18-jul-2026): si su única orden está
   * ENTREGADA, el cliente está RECOMPRANDO y la venta SÍ se sube. Esa decisión
   * la toma el guard de siempre mirando el estado real. En cuanto la orden se
   * ve en el espejo, esta lógica se aparta y lo deja decidir a él. Bloquear
   * acá sería reintroducir la venta perdida en silencio.
   */
  it('si la gemela YA se ve en el espejo, se aparta: decide el guard de siempre', () => {
    const g = elegirGemeloCiego([fila('S-1', TEL, '38398872880')], T9, 'S-2', new Set(['38398872880']));
    expect(g).toBeNull();
  });

  it('otro teléfono no es gemelo de nadie', () => {
    expect(elegirGemeloCiego([fila('S-1', '3001112233', '999')], T9, 'S-2', new Set())).toBeNull();
  });

  it('un pedido no es gemelo de sí mismo: reintentar el MISMO no se frena acá', () => {
    expect(elegirGemeloCiego([fila('S-1', TEL, '999')], T9, 'S-1', new Set())).toBeNull();
  });

  /**
   * Un intento sin `dropi_order_id` es un 'pending' en curso o un 'unknown'
   * que quedó sin confirmar: no se puede comprobar en el espejo. Se trata como
   * ciego a propósito — equivocarse en esta dirección cuesta un aviso que la
   * asesora puede saltear con "No es duplicado"; equivocarse al revés cuesta
   * un flete doble y un cliente que recibe dos veces lo mismo.
   */
  it('un intento sin número de orden se trata como ciego, no como resuelto', () => {
    expect(elegirGemeloCiego([fila('S-1', TEL, null)], T9, 'S-2', new Set())?.shopify_order_id).toBe('S-1');
  });

  it('el teléfono se compara por los últimos 9 dígitos, con o sin indicativo', () => {
    expect(elegirGemeloCiego([fila('S-1', '+57 314 866 4637', '9')], T9, 'S-2', new Set())).not.toBeNull();
  });

  /**
   * Un teléfono corto no identifica a nadie: con 3 dígitos "coincidirían"
   * clientes distintos y frenaríamos ventas buenas.
   */
  it('un teléfono demasiado corto NO frena nada', () => {
    expect(elegirGemeloCiego([fila('S-1', '123', '9')], '123', 'S-2', new Set())).toBeNull();
    expect(elegirGemeloCiego([fila('S-1', '', '9')], '', 'S-2', new Set())).toBeNull();
  });

  it('sin intentos previos no inventa un gemelo', () => {
    expect(elegirGemeloCiego([], T9, 'S-2', new Set())).toBeNull();
  });

  /**
   * ⛔ «QUIEN VE, CEDE» (4-sep-2026). Después de reclamar, el push vuelve a
   * preguntar excluyendo SU PROPIA fila. Cualquier OTRA fila viva del teléfono
   * —aunque su shopify_order_id sea distinto y esté 'pending'— es motivo para
   * ceder. Sin desempate: el que comiteó segundo ve al primero.
   */
  it('después del claim: la fila propia se excluye por id, cualquier OTRA fila viva del teléfono frena', () => {
    const mia: FilaPush = { id: 'claim-A', shopify_order_id: 'S-A', dropi_order_id: null, payload: { phone: TEL } };
    const otra: FilaPush = { id: 'claim-B', shopify_order_id: 'S-B', dropi_order_id: null, payload: { phone: TEL } };
    // Solo la mía: no soy gemela de mí misma.
    expect(elegirGemeloCiego([mia], T9, 'S-A', new Set(), 'claim-A')).toBeNull();
    // La mía y otra pending: cedo ante la otra.
    expect(elegirGemeloCiego([mia, otra], T9, 'S-A', new Set(), 'claim-A')?.shopify_order_id).toBe('S-B');
    // Y desde el otro lado pasa lo mismo: simétrico, sin desempate.
    expect(elegirGemeloCiego([mia, otra], T9, 'S-B', new Set(), 'claim-B')?.shopify_order_id).toBe('S-A');
  });

  /**
   * La ventana existe para cubrir el lag del espejo, NO el horizonte de
   * recompra. Si alguien la estirara a semanas, este candado empezaría a
   * frenar recompras legítimas — que es exactamente el error que la regla del
   * 18-jul-2026 vino a arreglar.
   */
  it('la ventana es de horas, no de meses', () => {
    expect(VENTANA_GEMELO_MS).toBeLessThanOrEqual(48 * 3600_000);
    expect(VENTANA_GEMELO_MS).toBeGreaterThanOrEqual(6 * 3600_000);
  });
});
