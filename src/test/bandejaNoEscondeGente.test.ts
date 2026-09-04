import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — la bandeja no puede esconder a quien está esperando.
 *
 * Medido en producción el 4-sep-2026 contra Ecuador, dos veces y con métodos
 * distintos (paginando por fecha de mensaje y barriendo la tabla por `id`):
 *
 *   esperando respuesta, de verdad ..........  273
 *   los que la pantalla mostraba ............   83
 *   INVISIBLES ..............................  190   ← 172 de ellos hace +7 días
 *   el más viejo ............................   31 días
 *
 * `useInboxEsperando` pedía las 500 conversaciones con entrada MÁS RECIENTE y
 * después ordenaba la lista "quien lleva más esperando, primero". Son dos cosas
 * opuestas: el tope se queda con lo nuevo y esta pantalla existe para lo viejo.
 * El corte caía en ~1 día de antigüedad.
 *
 * Y ya estaba prohibido por escrito: `controlDelTurno` cita la regla del dueño
 * —"que los pedidos no se escondan, eso está prohibido; siempre que se muestre
 * el total que hay que trabajar"—. Esa prueba vigilaba el BUSCADOR; el tope
 * escondía 190 personas por su cuenta.
 *
 * Esta prueba fija las tres piezas del arreglo:
 *  1. el filtro y el orden se hacen EN LA BASE (comparar `chat_entrante_at`
 *     contra `chat_saliente_at` es una comparación entre columnas, y PostgREST
 *     no la sabe expresar: por eso no alcanza con subir el tope);
 *  2. el hook cae al camino viejo si la migración todavía no corrió — sin eso,
 *     publicar el frontend antes que el SQL deja la bandeja caída en TODAS las
 *     rutas, porque la barra del turno monta este mismo hook;
 *  3. la pantalla DICE cuántos hay en total cuando muestra menos.
 */
const RAIZ = process.cwd();
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8');

const HOOK = leer('src/hooks/useInboxEsperando.ts');
const PAGE = leer('src/pages/InboxPage.tsx');
const SQL = leer('supabase/migrations/20260904170000_bandeja_completa.sql');

describe('⛔ la bandeja no esconde a quien espera', () => {
  it('el filtro y el orden viven en la base, no en un tope de filas recientes', () => {
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.bandeja_esperando');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.bandeja_sin_respuesta');
    // El cliente habló ÚLTIMO: comparación entre columnas.
    expect(SQL).toMatch(/chat_entrante_at > coalesce\(o\.chat_saliente_at/);
    // Del que lleva MÁS esperando al que menos. Si esto se invierte, volvemos
    // exactamente al bug: recortar por lo nuevo y prometer lo viejo.
    expect(SQL, 'la cola de espera dejó de ordenar del más viejo al más nuevo')
      .toMatch(/ORDER BY e\.chat_entrante_at ASC/);
    expect(SQL, 'la canasta de deuda dejó de ordenar del más viejo al más nuevo')
      .toMatch(/ORDER BY d\.chat_saliente_at ASC/);
    // Y el total sin recortar viaja con las filas.
    expect(SQL).toMatch(/count\(\*\) OVER \(\) AS total_general/);
  });

  it('el hook usa las funciones nuevas y cae al camino viejo si no están aplicadas', () => {
    expect(HOOK).toContain("rpc('bandeja_esperando'");
    expect(HOOK).toContain("rpc('bandeja_sin_respuesta'");
    // El respaldo: PGRST202 / "does not exist" → `false` → sigue la consulta vieja.
    expect(HOOK, 'sin el respaldo, publicar antes que el SQL tumba la bandeja en toda la app')
      .toMatch(/PGRST202/);
    expect(HOOK).toMatch(/if \(await cargarPorRpc\(storeId, seq, desdePromesas\)\) return;/);
  });

  it('el hook expone el total REAL de cada canasta', () => {
    expect(HOOK).toMatch(/totalEsperando: number \| null/);
    expect(HOOK).toMatch(/totalSinRespuesta: number \| null/);
    // Y el camino viejo NO inventa un total: dice que no lo sabe.
    expect(HOOK).toMatch(/totalEsperando: null/);
  });

  it('la pantalla dice cuántos hay en total cuando muestra menos', () => {
    expect(PAGE).toMatch(/totalDeLaCola/);
    expect(PAGE, 'la bandeja volvió a mostrar su lista recortada como si fuera el total')
      .toMatch(/totalDeLaCola != null && totalDeLaCola > cola\.length/);
  });

  // ⛔ 4-sep-2026, medido en produccion DESPUES de aplicar el SQL. Al editar un
  // pedido Dropi lo RECREA y deja el viejo REEMPLAZADA, pero el sync copia los
  // sellos de chat a las DOS filas: la vieja quedaba "esperando" para siempre.
  // Eran 193 de 281 en la cola de Ecuador y 385 de 776 en la de deuda, y por
  // ser las mas viejas se sentaban ARRIBA de la lista. Hasta ese dia el tope de
  // 500 las tapaba por accidente; mostrar la cola completa las habria puesto
  // primeras. En 12 de 12 revisadas el gemelo vivo ya estaba ENTREGADO.
  describe('los pedidos muertos no ocupan la cola', () => {
    it('las dos funciones excluyen REEMPLAZADA', () => {
      const filtros = SQL.match(/NOT IN\s*\(\s*'ENTREGADO'[^)]*\)/g) ?? [];
      expect(filtros, 'faltan los dos filtros de estado terminal').toHaveLength(2);
      for (const f of filtros) {
        expect(f, 'un pedido REEMPLAZADA no es una mano levantada: su gemelo vivo es el que vale')
          .toContain("'REEMPLAZADA'");
      }
      // Las variantes por transportadora ('CANCELADO POR TRANSPORTADORA').
      expect(SQL.match(/NOT LIKE '%CANCEL%'/g) ?? []).toHaveLength(2);
    });

    it('el camino de respaldo del cliente filtra IGUAL que la funcion', () => {
      expect(HOOK, 'si las dos listas se separan, el numero depende de si el SQL esta aplicado')
        .toMatch(/const TERMINALES = new Set\(\[[\s\S]*?'REEMPLAZADA'[\s\S]*?\]\)/);
      expect(HOOK).toMatch(/e\.includes\('CANCEL'\)/);
      // Y el filtro se aplica por la funcion, no por el Set pelado (que se
      // saltaba las variantes).
      expect(HOOK).toMatch(/if \(esTerminal\(r\.estado\)\) return;/);
    });

    it('DEVOLUCION se queda ADENTRO a proposito', () => {
      // El paquete vuelve pero la conversacion sigue viva. Sacarlo es decision
      // de negocio, no parte de este arreglo: si alguien lo agrega sin hablarlo,
      // desaparecen 95 conversaciones de Ecuador de golpe.
      const filtros = SQL.match(/NOT IN\s*\(\s*'ENTREGADO'[^)]*\)/g) ?? [];
      for (const f of filtros) expect(f).not.toContain('DEVOLUC');
      expect(SQL).not.toMatch(/NOT LIKE '%DEVOLUC%'/);
    });
  });
});
