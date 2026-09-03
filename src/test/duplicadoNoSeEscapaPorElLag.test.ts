import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — ningún candado anti-duplicado puede depender SOLO del espejo.
 *
 * El 3-sep-2026 una asesora mandó la foto de un pedido con DOS guías, con
 * números consecutivos (…880 y …881). Los tres candados que existían —el del
 * robot, el del panel y el del servidor— preguntaban lo mismo: *¿este teléfono
 * ya tiene una orden en `orders`?*. Y `orders` es el espejo de Dropi: la fila
 * entra cuando el cron la importa, no cuando la orden se crea. Por esa ventana
 * pasaban dos ventas del mismo cliente sin que nadie las viera.
 *
 * Esta prueba exige que el push consulte ADEMÁS una fuente sin lag —nuestro
 * propio registro de intentos— y que lo haga ANTES de crear nada en Dropi.
 * Preguntar después de crear la orden no es un candado: es un informe.
 */

const RAIZ = join(process.cwd(), 'supabase', 'functions');
const push = readFileSync(join(RAIZ, 'shopify-push-dropi', 'index.ts'), 'utf8');
const puro = readFileSync(join(RAIZ, '_shared', 'gemeloInvisible.ts'), 'utf8');

/**
 * Comentarios fuera. `\r?\n` y NO `\n` a secas: con finales CRLF, un `.` no
 * cruza el `\r` y el borrado de comentarios falla en silencio — una afirmación
 * positiva pasaría en verde con el texto viviendo solo dentro de un comentario.
 * Ya mordió en tres guardianes de este repo.
 */
const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

const codigo = sinComentarios(push);

describe('⛔ el duplicado no se escapa por el lag del espejo', () => {
  it('el push consulta una fuente SIN lag: nuestro registro de intentos', () => {
    expect(
      /from\(["']shopify_pushed_orders["']\)[\s\S]{0,400}?payload/.test(codigo),
      'el push ya no lee el teléfono de shopify_pushed_orders: vuelve a depender solo del espejo',
    ).toBe(true);
    expect(codigo).toMatch(/elegirGemeloCiego/);
  });

  it('pregunta ANTES de crear en Dropi, no después', () => {
    const iGuard = codigo.indexOf('findInvisibleTwin(sb');
    const iClaim = codigo.indexOf('status: "pending"');
    const iPost = codigo.indexOf('integrations/orders/myorders');
    expect(iGuard, 'no se llama al guard del gemelo invisible').toBeGreaterThan(-1);
    expect(iGuard, 'el guard corre DESPUÉS del claim: ya sería tarde').toBeLessThan(iClaim);
    expect(iGuard, 'el guard corre DESPUÉS del POST a Dropi: eso no es un candado, es un informe')
      .toBeLessThan(iPost);
  });

  /**
   * ⛔ «QUIEN VE, CEDE» (4-sep-2026). El chequeo de arriba corre ANTES del
   * claim, y en ese instante dos ventas distintas del mismo teléfono todavía
   * no tienen fila ninguna: las dos pasaban. Después de reclamar hay que volver
   * a mirar, excluyendo la fila propia (`claimId`), y ceder si aparece otra.
   * Sin desempate: `pushed_at` es el inicio de la transacción, no el orden de
   * commit, y con un desempate los dos podían "ganar".
   */
  it('vuelve a preguntar DESPUÉS del claim, excluyendo su propia fila, y cede', () => {
    const iClaim = codigo.indexOf('status: "pending"');
    const iPost = codigo.indexOf('integrations/orders/myorders');
    const iRecheck = codigo.indexOf('findInvisibleTwin(sb, storeId, phoneNorm, shopifyOrderId, claimId)');
    expect(iRecheck, 'no hay re-chequeo post-claim con el claim propio excluido').toBeGreaterThan(iClaim);
    expect(iRecheck, 'el re-chequeo corre después del POST: ya sería un informe').toBeLessThan(iPost);
    // Y cede: la fila propia pasa a error y se responde duplicado.
    const trasRecheck = codigo.slice(iRecheck, iPost);
    expect(trasRecheck, 'el re-chequeo no cede: encontró gemelo y siguió').toMatch(/status:\s*"error"[\s\S]{0,300}duplicate_phone/);
    // Nada de desempate por fecha.
    expect(trasRecheck).not.toMatch(/pushed_at\s*[<>]/);
  });

  /**
   * ⛔ FAIL-CLOSED (4-sep-2026). Antes: `catch {}` y el push seguía. Con la
   * base lenta, "Subir todos" de 20 creaba 20 sin candado.
   */
  it('si el candado no puede correr, el push se FRENA (no degrada abierto)', () => {
    // El bloque del guard (desde la primera llamada al gemelo hasta el claim)
    // no puede tener un catch vacío: tiene que responder guard_failed.
    const iGuard = codigo.indexOf('findInvisibleTwin(sb');
    const iClaim = codigo.indexOf('status: "pending"');
    const bloqueGuard = codigo.slice(iGuard, iClaim);
    expect(bloqueGuard, 'el guard volvió a tragarse el error y seguir').not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
    expect(bloqueGuard, 'el guard no responde guard_failed cuando no puede correr').toMatch(/blocked:\s*"guard_failed"/);
    const puroSinComentarios = sinComentarios(push);
    // La lectura fallida del registro de intentos tiene que SUBIR, no loguearse.
    expect(puroSinComentarios).toMatch(/no pude leer shopify_pushed_orders[\s\S]{0,80}\)/);
    expect(puroSinComentarios).toMatch(/throw new Error\(`no pude leer shopify_pushed_orders/);
  });

  /**
   * ⛔ UN 5xx NO ES UN RECHAZO (4-sep-2026). Un 502/504 del gateway que llega
   * después de que Dropi insertó caía en 'error', `safeToRetry` dejaba
   * reintentar sin "Forzar" y el robot lo retomaba solo a las 2 h. Segunda
   * orden real. Y el POST era el único fetch a Dropi sin timeout.
   */
  it('solo un rechazo SEGURO (4xx de validación) queda reintentable; el resto es unknown', () => {
    expect(codigo).toMatch(/function esRechazoSeguro\(/);
    expect(codigo, 'el 5xx vuelve a marcarse error').toMatch(/if\s*\(\s*!dropiOk\s*&&\s*rechazoSeguro\s*\)/);
    const iPost = codigo.indexOf('integrations/orders/myorders');
    const bloquePost = codigo.slice(iPost, iPost + 900);
    expect(bloquePost, 'el POST de creación no tiene timeout').toMatch(/AbortSignal\.timeout\(/);
  });

  /**
   * La recompra legítima tiene que seguir teniendo salida. Sin el escape, un
   * cliente que compra dos veces el mismo día queda trabado sin forma de
   * destrabarlo — la venta perdida en silencio que la regla del 18-jul-2026
   * vino justamente a arreglar.
   */
  it('respeta el escape manual "No es duplicado"', () => {
    const iEscape = codigo.indexOf('if (!allowDuplicate');
    const iGuard = codigo.indexOf('findInvisibleTwin(sb');
    expect(iEscape).toBeGreaterThan(-1);
    expect(iEscape, 'el guard quedó fuera del escape: una recompra real no se podría subir nunca')
      .toBeLessThan(iGuard);
  });

  /**
   * Si la lógica pura decidiera leyendo `orders`, volvería a tener el mismo
   * lag y el arreglo sería decorativo.
   */
  it('la decisión pura no vuelve a apoyarse en el espejo', () => {
    expect(sinComentarios(puro)).not.toMatch(/\borders\b/);
  });

  /**
   * ⛔ EL LOTE CONTRA SÍ MISMO. El duplicado del 3-sep-2026 fue en Colombia 2,
   * que tiene el robot Shopify APAGADO: salió del botón "Subir todos". El filtro
   * del panel compara contra lo que YA está en Dropi, y dos ventas nuevas del
   * mismo teléfono no estaban ninguna — las dos se subían en el mismo bucle.
   * Este botón existe en las TRES tiendas, con robot o sin él.
   */
  it('"Subir todos" no sube dos veces el mismo teléfono en el mismo lote', () => {
    const panel = sinComentarios(
      readFileSync(join(process.cwd(), 'src', 'components', 'confirmar', 'ShopifyPendingPanel.tsx'), 'utf8'),
    );
    expect(panel, 'el lote volvió a compararse solo contra Dropi, no contra sí mismo')
      .toMatch(/repetidosEnElLote\(/);
    const iRep = panel.indexOf('repetidosEnElLote(');
    const iTargets = panel.indexOf('const targets =');
    expect(iRep, 'se calcula después de armar la lista a subir: no la filtra').toBeLessThan(iTargets);
  });

  /**
   * ⛔ CONFIRMAR NO PUEDE DESPACHAR DOS VECES AL MISMO CLIENTE.
   *
   * *"Le dio en confirmar y se duplica"* (dueño, 3-sep-2026). El chip de
   * DUPLICADO ya existía y ya veía los dos pendientes del mismo teléfono en la
   * cola — pero era SOLO un chip: la tecla 1, el atajo VIP y el botón
   * confirmaban igual. Un aviso que se puede ignorar sin decir nada no es un
   * candado.
   */
  it('confirmar pregunta ANTES cuando el cliente tiene otro pedido en curso', () => {
    const call = sinComentarios(
      readFileSync(join(process.cwd(), 'src', 'components', 'CallView.tsx'), 'utf8'),
    );
    expect(call, 'CallView ya no consulta el aviso de duplicado antes de confirmar')
      .toMatch(/avisoAntesDeConfirmar\(/);
    // Llamarla no alcanza: hay que ACTUAR sobre la respuesta. Sin esto, un
    // `if (false)` dejaba el guárdian en verde con el candado desactivado
    // — comprobado reinyectándolo.
    expect(call, 'se calcula el aviso pero no se frena con él')
      .toMatch(/if\s*\(\s*aviso\.frena\s*\)/);
    const iAviso = call.indexOf('avisoAntesDeConfirmar(');
    const iMark = call.indexOf('await doMark(');
    expect(iAviso, 'el aviso se consulta DESPUÉS de marcar: ya salió la guía')
      .toBeLessThan(iMark);
    // Y la salida tiene que existir: si no, una recompra real queda trabada.
    expect(call, 'no queda forma de confirmar una recompra real')
      .toMatch(/decididoDuplicado\.current\.add/);
  });

  /** Sin esto, el arreglo vive en main y el runtime sigue duplicando. */
  it('las dos funciones del camino Shopify→Dropi pueden decir qué versión corren', () => {
    for (const fn of ['shopify-push-dropi', 'shopify-auto-push']) {
      const src = readFileSync(join(RAIZ, fn, 'index.ts'), 'utf8');
      expect(src, `${fn} no declara VERSION`).toMatch(/^const VERSION = "/m);
      expect(src, `${fn} no contesta el ping`).toMatch(/respuestaPing\(\s*req/);
    }
  });
});
