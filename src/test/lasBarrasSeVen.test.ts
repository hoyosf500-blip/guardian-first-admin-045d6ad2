import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: los gradientes de un gráfico van DENTRO de un `<defs>` de verdad.
 *
 * ── El bug, medido en producción el 5-sep-2026 ─────────────────────────────
 * `/admin → Productividad → Comparativa por asesora`, tienda de Ecuador, rango
 * 7 días. En pantalla: la grilla, el eje Y escalado **0..400** (o sea con datos
 * reales adentro), el eje X con ROBERTO MORAN y ESTEFANO MORENO… y **ni una
 * sola barra dibujada**.
 *
 * En el DOM las barras SÍ estaban, con su geometría correcta, pintadas con
 * `fill="url(#prodComp-conf)"` — y `prodComp-conf` **no existía en el
 * documento**: el `<svg>` tenía CERO definiciones de gradiente.
 *
 * ── Por qué ────────────────────────────────────────────────────────────────
 * recharts recorre los hijos del chart y solo deja pasar los que RECONOCE. Un
 * componente propio —`<BarGradientDefs/>`, que devuelve un `<defs>`— no está
 * en esa lista, así que lo **descarta en silencio**: no hay error, no hay
 * warning, no hay nada. El gradiente nunca llega al DOM y cada barra queda
 * apuntando a un id inexistente. Una barra con `fill` roto no se dibuja de
 * ningún color: se dibuja de ninguno.
 *
 * Un `<defs>` a secas SÍ es un elemento que recharts deja pasar, y adentro
 * React renderiza lo que sea. Por eso `DailyReportsView` —el único de los
 * cinco que ya lo envolvía así— era el único que se veía.
 *
 * ⛔ Esto ya está escrito en CLAUDE.md desde el 23-ago-2026, con la advertencia
 * de que estos mismos archivos eran «candidatos al mismo bug, verificar en
 * pantalla». Nadie los verificó hasta hoy. De ahí esta prueba: para que la
 * próxima vez no haga falta que alguien se acuerde de mirar.
 *
 * Si esta prueba se pone roja: envolvé el `<BarGradientDefs/>` en un `<defs>`,
 * como hacen los cinco call-sites de hoy. No la relajes — el costo de que pase
 * es un gráfico que miente durante meses sin que nadie se entere.
 */

const RAIZ = join(__dirname, '..');

function archivosTsx(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'test' || e === 'node_modules') continue;
      archivosTsx(p, acc);
    } else if (e.endsWith('.tsx')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Tapa los comentarios con espacios, DEJANDO cada carácter en su lugar (y los
 * saltos de línea intactos), para que los índices y los números de línea del
 * texto original sigan valiendo.
 *
 * ⛔ Sin esto la prueba daba VERDE sobre el bug. `ProductivityDashboard.tsx`
 * tiene, en el JSDoc de la línea 171, la frase «los ids de `<defs>` son
 * GLOBALES al documento» — y ese `<defs>` de PROSA contaba como una apertura
 * real. El contador quedaba en 2 aperturas contra 1 cierre y concluía que el
 * componente estaba adentro de un `<defs>` cuando colgaba del chart.
 *
 * Es exactamente la trampa que CLAUDE.md ya documenta para el helper
 * `sinComentarios` de `googleApagado`: un guardián que lee texto tiene que
 * distinguir el código de lo que se dice SOBRE el código.
 */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** ¿La posición `idx` está DENTRO de un `<defs>` sin cerrar? Se cuenta sobre el
 *  texto ya sin comentarios: solo valen los `<defs>` que son código. */
function estaDentroDeDefs(codigo: string, idx: number): boolean {
  const antes = codigo.slice(0, idx);
  const abre = (antes.match(/<defs[\s>]/g) ?? []).length;
  const cierra = (antes.match(/<\/defs>/g) ?? []).length;
  return abre > cierra;
}

describe('un gráfico con datos tiene que DIBUJAR las barras', () => {
  it('todo <BarGradientDefs/> vive dentro de un <defs>, nunca colgando del chart', () => {
    const fuera: string[] = [];
    let vistos = 0;

    for (const archivo of archivosTsx(RAIZ)) {
      const codigo = sinComentarios(readFileSync(archivo, 'utf8'));
      const re = /<BarGradientDefs[\s/>]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(codigo)) !== null) {
        vistos++;
        if (!estaDentroDeDefs(codigo, m.index)) {
          const linea = codigo.slice(0, m.index).split('\n').length;
          fuera.push(`${archivo.replace(RAIZ, 'src')}:${linea}`);
        }
      }
    }

    // Sin esta guarda, borrar el componente (o cambiarle el nombre) daría VERDE
    // sin haber mirado nada — el mismo "todo limpio" mentiroso del badge de la
    // billetera. Si de verdad se elimina, hay que reescribir esta prueba.
    expect(vistos, 'no se encontró ni un <BarGradientDefs/>: la prueba no está probando nada').toBeGreaterThan(0);
    expect(
      fuera,
      'recharts DESCARTA los componentes propios que cuelgan del chart: ' +
      'estos gradientes no llegan al DOM y sus barras se dibujan invisibles. ' +
      'Envolvelos en <defs>…</defs>',
    ).toEqual([]);
  });
});
