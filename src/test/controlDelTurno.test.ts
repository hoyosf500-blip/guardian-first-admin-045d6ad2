import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PRUEBAS GUARDIANAS de la tanda del 3-sep-2026 — «que Guardian tenga la última
 * palabra».
 *
 * Las tres reglas de abajo son baratas de cumplir y carísimas de descubrir a
 * mano: las tres protegen números que el dueño lee para hablar con una persona.
 * Si alguna se pone roja, el problema es el cambio, no la prueba.
 */

const leer = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Quita comentarios. El `(?<!:)` evita comerse el `//` de un `https://` — sin
 *  él, media línea desaparece y las comprobaciones negativas pasan en verde CON
 *  el código presente. Misma trampa documentada en `googleApagado.test.ts`. */
function sinComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // OJO: se parte con \r? tambien. Con archivos en CRLF (git los
    // normaliza solo) cada linea termina en retorno de carro, y el punto de
    // una regex NO lo cruza: la de abajo no matcheaba y los comentarios NO se
    // borraban. Eso rompe el helper en las DOS direcciones — una comprobacion
    // negativa da rojo por una palabra que solo estaba en un comentario, y una
    // POSITIVA pasa en verde con el texto viviendo solo en un comentario.
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

/**
 * ⛔ EL MAPA DE CALOR NO PUEDE SALIR DE UNA FUENTE CAPADA.
 *
 * `useLiveTeam` lee las 400 marcas más recientes de TODA la tienda
 * (`EVENT_SCAN_LIMIT`) — el propio hook advertía que "las horas más viejas
 * subcontarían". Con cinco asesoras a ~120 gestiones ese tope se pasa antes del
 * mediodía, así que la franja de la mañana salía corta. Sobre esa franja el
 * dueño le reclama a alguien: un número corto ahí no es un detalle de precisión.
 */
describe('el mapa de calor lee el día entero, no las últimas 400 marcas', () => {
  it('no consume `useLiveTeam` ni su tope', () => {
    const hook = sinComentarios(leer('src/hooks/useMapaCalorDia.ts'));
    const comp = sinComentarios(leer('src/components/admin/MapaCalorEquipo.tsx'));
    for (const [nombre, src] of [['el hook', hook], ['la pantalla', comp]] as const) {
      expect(/useLiveTeam/.test(src), `${nombre} no puede alimentarse de useLiveTeam (capado a 400)`).toBe(false);
      expect(/EVENT_SCAN_LIMIT/.test(src), `${nombre} no puede usar EVENT_SCAN_LIMIT`).toBe(false);
    }
  });

  it('pagina hasta agotar el día en vez de pedir un lote y creerle', () => {
    const hook = sinComentarios(leer('src/hooks/useMapaCalorDia.ts'));
    expect(/\.range\(/.test(hook), 'sin paginar, un día con volumen queda cortado').toBe(true);
  });

  /**
   * ⛔ `orders.created_at` es cuándo el CRON insertó el pedido, corrido +5 h de
   * mediana. Ya produjo una conclusión falsa que hubo que retractar ("la franja
   * de la noche cancela 48%"). Las horas tienen que salir de la GESTIÓN.
   */
  it('no mide franjas con la hora en que el cron insertó el pedido', () => {
    const hook = sinComentarios(leer('src/hooks/useMapaCalorDia.ts'));
    // ⛔ Se prohíbe la PALABRA, no la forma `from('orders')`. La primera versión
    // de esta prueba buscaba el literal y se la esquivó reinyectando el bug como
    // `.from(tabla === 'touchpoints' ? 'orders' : tabla)`: pasó en verde con la
    // tabla equivocada adentro. Una comprobación que solo reconoce la forma en
    // que se escribió el bug la primera vez no protege nada.
    // `order_results` no matchea: se exige `orders` como palabra completa.
    expect(
      /\borders\b/.test(hook),
      'el mapa no puede tocar `orders`: su created_at es cuándo el cron insertó el pedido, no cuándo trabajó la persona',
    ).toBe(false);
    expect(/touchpoints/.test(hook) && /order_results/.test(hook)).toBe(true);
  });

  it('las barritas capadas de la tarjeta ya no existen', () => {
    const card = sinComentarios(leer('src/components/admin/AdvisorCard.tsx'));
    expect(/function Barritas/.test(card), 'volvió el sparkline que subcontaba').toBe(false);
    expect(/vm\.hourly/.test(card)).toBe(false);
    const vm = sinComentarios(leer('src/lib/advisorCardVM.ts'));
    expect(/hourly/.test(vm), 'un dato que miente y sigue declarado, alguien lo vuelve a dibujar').toBe(false);
  });
});

/**
 * ⛔ LA BANDEJA TIENE QUE ESTAR EN LA ESCALERA DEL TURNO.
 *
 * `ESCALERA` no tenía ningún escalón a `/inbox`: con 40 clientes sin contestar,
 * la barra mandaba a cualquier otro lado y nunca ahí. Es el mismo hueco que ya
 * costó caro en Colombia — «todos atendidos 🎉» con 39 esperando, 22 de ellos
 * hacía más de un día.
 */
describe('la bandeja está en el orden del turno', () => {
  const src = sinComentarios(leer('src/lib/siguienteAccion.ts'));

  it('la escalera manda a /inbox', () => {
    expect(/ruta:\s*['"]\/inbox['"]/.test(src), 'ningún escalón lleva a la bandeja').toBe(true);
  });

  it('los dos escalones nuevos existen como claves', () => {
    for (const k of ['bandeja', 'sin_respuesta']) {
      expect(src.includes(`'${k}'`), `falta el escalón ${k}`).toBe(true);
    }
  });

  it('la barra del turno lee la bandeja de verdad', () => {
    const bar = sinComentarios(leer('src/components/SiguienteAccionBar.tsx'));
    expect(/useInboxEsperando/.test(bar), 'la barra no puede dirigir a una cola que no lee').toBe(true);
  });

  /**
   * ⛔ Y el banner de «Terminaste Confirmar» tampoco puede celebrar sin mirar la
   * bandeja: es literal lo que pidió el dueño — *"si terminó le señale que
   * falta Inbox"*.
   */
  it('el banner de fin de cola también la mira', () => {
    const banner = sinComentarios(leer('src/components/SiguienteColaBanner.tsx'));
    expect(/useInboxEsperando/.test(banner)).toBe(true);
    expect(/\/inbox/.test(banner)).toBe(true);
  });
});

/**
 * ⛔ A UNA PERSONA NO SE LE CUELGA EL TRABAJO DEL BOT.
 *
 * `orders.chat_saliente_tipo` distingue 'plantilla' de 'directo' — pero dice
 * QUÉ se mandó, no QUIÉN lo mandó, y el bot manda plantillas todo el día
 * (`actividadChat.ts`: *"el export de ImporChat NO dice si fue el bot o una
 * asesora"*). Atribuir con esa columna le cargaría a una asesora el trabajo de
 * un robot, y con ese número no se puede hablar con nadie.
 */
describe('la atribución de "les escribió y no volvió" no confunde al bot con una persona', () => {
  it('no se atribuye por chat_saliente_tipo', () => {
    const lib = sinComentarios(leer('src/lib/plantillasSinVuelta.ts'));
    expect(
      /chat_saliente_tipo|salienteTipo/.test(lib),
      'esa columna no dice quién mandó el mensaje — la atribución va por touchpoints (operator_id)',
    ).toBe(false);
  });

  it('lo que no se puede atribuir va aparte, no al último que pasó cerca', () => {
    const lib = leer('src/lib/plantillasSinVuelta.ts');
    expect(/sinAtribuir/.test(lib)).toBe(true);
  });

  it('con la lectura caída no se afirma un cero por asesora', () => {
    const lib = sinComentarios(leer('src/lib/plantillasSinVuelta.ts'));
    expect(/if\s*\(\s*!medido/.test(lib), 'un cero que sale de no haber podido leer se lee como buena noticia').toBe(true);
  });
});

/**
 * ⛔ EL RE-REPARTO NO PUEDE VOLVER A APAGARSE CON UNA LÍNEA.
 *
 * `repartirCola` y la RPC estaban hechas para correr varias veces al día (la
 * RPC trae `ON CONFLICT DO NOTHING` documentado como "lo que hace seguro volver
 * a correr el reparto durante el día"). El llamador lo bloqueaba con un corte
 * por `asignaciones.size` y un sello en localStorage: los pedidos que entraban
 * después de la mañana quedaban sin dueño hasta el otro día, y la que terminaba
 * su lote no recibía más nunca.
 */
describe('el reparto vuelve a correr durante el día', () => {
  const src = sinComentarios(leer('src/components/tabs/SeguimientoTab.tsx'));

  it('no se apaga cuando ya hay asignaciones', () => {
    expect(
      /if\s*\(\s*asig\.asignaciones\.size\s*>\s*0\s*\)\s*return/.test(src),
      'este corte deja sin dueño todo lo que entra después del reparto de la mañana',
    ).toBe(false);
  });

  it('no vuelve el sello por día en localStorage', () => {
    expect(
      /setItem\(\s*llave/.test(src),
      'sellar el día apaga el reparto para el resto de la jornada',
    ).toBe(false);
  });

  it('sigue exigiendo el mapa leído antes de repartir', () => {
    // Repartir viendo el mapa vacío "porque todavía no leí" le apila a una sola
    // persona todo lo que no tenía dueño. Es un bug ya cometido (28-ago-2026).
    expect(/asig\.cargado/.test(src)).toBe(true);
  });
});

/**
 * ⛔ NO SE LE ASIGNA TRABAJO A QUIEN NO ESTÁ TRABAJANDO.
 *
 * Pedido del dueño (3-sep-2026): *"si no hay actividad no le puede asignar"*.
 * Hasta hoy bastaba con haber marcado entrada: quien fichaba a las 8, se iba a
 * las 9 y no volvía seguía recibiendo un tercio de la cola a las 3 de la tarde,
 * y ese tercio no lo trabajaba nadie. Es medio problema del sistema de
 * auto-asignación que se apagó en mayo-2026 (pedidos con dueño y sin gestión).
 */
describe('el reparto mira la actividad, no la marca de entrada', () => {
  const src = sinComentarios(leer('src/hooks/useSegAsignaciones.ts'));

  it('la presencia exige señal reciente', () => {
    expect(/presentesActivos\s*\(/.test(src), 'la presencia sigue saliendo de first_action_at a secas').toBe(true);
  });

  /**
   * ⛔ El fallback que deshacía el filtro justo en el caso que importa: con
   * NADIE activo, repartía entre el plantel completo.
   */
  it('sin nadie activo NO se cae al plantel completo', () => {
    expect(
      /filtrados\.length > 0 \? filtrados : operadores/.test(src),
      'este fallback reparte entre todas cuando no hay nadie trabajando',
    ).toBe(false);
  });

  it('pero si la lectura FALLA sí se reparte entre todas', () => {
    // Fallar cerrado sería peor: dejaría sin trabajo asignado a quien sí vino.
    expect(/presentes === null/.test(src)).toBe(true);
  });
});
