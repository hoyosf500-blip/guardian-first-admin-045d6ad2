import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ⛔ LAS CUATRO PANTALLAS DE TRABAJO TIENEN QUE DECIR QUIÉN TOCÓ EL PEDIDO.
 *
 * Pedido del dueño (3-sep-2026): *"necesito etiquetas para saber que el asesor
 * ya tocó ese pedido, sea en Confirmar, Seguimiento o Novedad y hasta en el
 * Inbox, **para yo no regañar**"*.
 *
 * Salió de un caso real: en Novedades una operadora dijo que había tocado un
 * pedido y no había con qué contrastarlo. La auditoría encontró por qué —
 * Novedades y la bandeja eran las dos únicas colas que **no leían las gestiones
 * en absoluto**, ni siquiera para mostrarlas.
 *
 * Esta prueba vigila que eso no vuelva a pasar. Si se pone roja, el problema es
 * el cambio, no la prueba.
 */

const leer = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Quita comentarios de línea. El `(?<!:)` es para no confundir el `//` de una
 *  URL con un comentario — el mismo cuidado que lleva `googleApagado`. */
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

const PANTALLAS: Array<{ nombre: string; ruta: string }> = [
  { nombre: 'Novedades', ruta: 'src/components/NovedadView.tsx' },
  { nombre: 'la bandeja (Escribieron)', ruta: 'src/pages/InboxPage.tsx' },
];

describe('el sello de "ya lo tocó" en las colas que no lo tenían', () => {
  for (const { nombre, ruta } of PANTALLAS) {
    it(`${nombre} lee las gestiones y dibuja el sello`, () => {
      const src = sinComentarios(leer(ruta));
      expect(
        /useSelloGestion\s*\(/.test(src),
        `${nombre} tiene que LEER las gestiones: sin eso la asesora no puede probar que lo tocó`,
      ).toBe(true);
      expect(
        /<SelloGestion\b/.test(src),
        `${nombre} tiene que DIBUJAR el sello, no solo leerlo`,
      ).toBe(true);
    });
  }

  /**
   * El sello nace como componente compartido justamente porque en el CRM ya
   * había ONCE dibujos distintos de esta misma etiqueta, hechos a mano. Una
   * duodécima versión suelta en estas dos pantallas volvería a abrir la puerta
   * a que digan cosas distintas sobre el mismo hecho.
   */
  it('no se dibuja un chip de gestión a mano en esas dos pantallas', () => {
    for (const { nombre, ruta } of PANTALLAS) {
      const src = sinComentarios(leer(ruta));
      expect(
        /Gestionad[oa] por|Gestionado hoy|Lo tocó|lo gestionó/i.test(src),
        `${nombre} escribe a mano una etiqueta de gestión — usá <SelloGestion>`,
      ).toBe(false);
    }
  });
});

/**
 * ⛔ EL SELLO NO PUEDE AFIRMAR "NADIE LO TOCÓ".
 *
 * Sobre esta etiqueta se decide si retar a una persona. Un cero dibujado antes
 * de que lleguen los datos —o después de una consulta que falló— es una
 * acusación falsa, y es exactamente el error que este componente vino a
 * corregir. Es la misma regla que ya costó caro en `/inbox` («todos atendidos»
 * sobre 39 clientes sin contestar) y en cancelaciones («no hubo cancelaciones»
 * sobre un mes con 345).
 */
describe('el sello se calla cuando no sabe', () => {
  const comp = leer('src/components/comun/SelloGestion.tsx');
  const hook = leer('src/hooks/useSelloGestion.ts');

  it('mientras carga no dibuja nada', () => {
    expect(/estado === 'inicial' \|\| estado === 'cargando'/.test(comp)).toBe(true);
    expect(/return null/.test(comp)).toBe(true);
  });

  it('si la lectura falló, lo dice en vez de callar', () => {
    expect(/estado === 'error'/.test(comp)).toBe(true);
    expect(/no pude ver si lo tocaron/i.test(comp)).toBe(true);
  });

  it('el hook distingue los cuatro estados, no devuelve un mapa vacío a secas', () => {
    for (const e of ['inicial', 'cargando', 'ok', 'error']) {
      expect(hook.includes(`'${e}'`), `falta el estado ${e}`).toBe(true);
    }
  });

  /**
   * Si UN lote de teléfonos falla, pintar el resto haría que la mitad de las
   * tarjetas dijera "nadie lo tocó" sobre pedidos que sí fueron gestionados.
   */
  it('un lote fallido no deja pintar un mapa a medias', () => {
    expect(/respuestas\.some\(\(r\) => r\.error\)/.test(hook)).toBe(true);
  });
});
