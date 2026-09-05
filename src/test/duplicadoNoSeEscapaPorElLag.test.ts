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

  // ⛔ EL ESLABÓN HUMANO (caso Johana Guerra, 4-sep-2026). Ningún candado del
  // servidor puede frenar una carga hecha en el panel de Dropi: no deja fila en
  // `shopify_pushed_orders` ni dispara el webhook. El robot creó #6854946 a las
  // 8:18 y el operador cargó #6854983 a mano 3 minutos después, porque buscó en
  // Dropi y no lo encontró — el espejo tarda hasta 15 min. El único lugar donde
  // se corta es la pantalla, ANTES del clic.
  it('el panel avisa ANTES de que el humano cargue a mano', () => {
    const panel = readFileSync(join(process.cwd(), 'src', 'components', 'confirmar', 'ShopifyPendingPanel.tsx'), 'utf8');
    expect(panel, 'el panel dejó de mirar lo que Guardian ya subió')
      .toMatch(/usePushesRecientes/);
    // Los dos botones que crean la guía a mano quedan deshabilitados.
    // Se ancla en el JSX del botón, no en el texto suelto: "Subir a Dropi" y
    // "Ya lo metí" también aparecen en comentarios del archivo.
    const iSubir = panel.indexOf('<Truck size={12} /> Subir a Dropi');
    expect(iSubir, 'no encontré el botón de subir').toBeGreaterThan(-1);
    expect(panel.slice(Math.max(0, iSubir - 600), iSubir)).toMatch(/disabled=\{blocked \|\| !!yaSubido\}/);
    const iMeti = panel.indexOf('handleYaLoMeti(p)');
    expect(iMeti, 'no encontré el botón de "Ya lo metí"').toBeGreaterThan(-1);
    expect(panel.slice(iMeti, iMeti + 300), 'se puede volver a marcar "Ya lo metí" sobre algo que Guardian ya subió')
      .toMatch(/!!yaSubido/);
    // Y el aviso dice lo único que destraba al operador: cómo encontrarlo en
    // Dropi. ⛔ Ya no alcanza con decirle "buscá por teléfono" (que es lo que
    // esta prueba exigía antes): medido el 4-sep-2026 contra el panel real,
    // el buscador de Dropi es coincidencia por SUBCADENA y con `+593…` devuelve
    // CERO — y Guardian le venía dando justo ese formato (15 de 16 teléfonos en
    // pantalla). El consejo correcto sin el número correcto igual termina en un
    // duplicado, así que la franja tiene que dar los DÍGITOS EXACTOS.
    expect(panel).toMatch(/Busc[áa] en Dropi con estos d[íi]gitos/);
    const iFranja = panel.indexOf('Buscá en Dropi con estos dígitos');
    expect(panel.slice(iFranja, iFranja + 400)).toContain('telefonoParaBuscarEnDropi(p.phone)');
  });

  it('la pantalla usa la MISMA ventana y la misma llave que el candado del servidor', () => {
    const hook = readFileSync(join(process.cwd(), 'src', 'hooks', 'usePushesRecientes.ts'), 'utf8');
    const gemelo = puro;
    // Si la pantalla mirara otra ventana que el servidor, dirían cosas distintas
    // sobre el mismo pedido — y la asesora le creería a la que está mirando.
    expect(gemelo).toMatch(/VENTANA_GEMELO_MS = 24 \* 60 \* 60 \* 1000/);
    expect(hook, 'la ventana de la pantalla se desalineó de la del servidor')
      .toMatch(/VENTANA_PUSH_MS = 24 \* 60 \* 60 \* 1000/);
    expect(hook, 'la llave de teléfono tiene que ser la misma: últimos 9 dígitos')
      .toMatch(/slice\(-9\)/);
  });
});
