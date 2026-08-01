import { describe, it, expect } from 'vitest';
import { classifySegEstado } from './segStatus';

/**
 * Guardián contra la columna "Otros".
 *
 * Dropi inventa rótulos nuevos cada par de meses y no avisa. Cuando uno cae sin
 * clasificar, el pedido no desaparece de la base pero SÍ del tablero donde la
 * asesora trabaja: se va al cajón "Otros", que nadie mira. Ya pasó dos veces
 * este mes (los 6 estados de Ecuador del 31-jul, 238 pedidos; y 'EN PUNTO DROOP',
 * que además escondía una urgencia real).
 *
 * Esta lista NO es inventada: es el censo de `orders.estado` de las dos tiendas
 * en los últimos 60 días, leído de producción el 1-ago-2026. Si mañana alguien
 * toca un matcher y rompe uno de estos, la prueba lo caza antes que la operadora.
 *
 * Para actualizar el censo:
 *   SELECT estado, count(*) FROM orders
 *   WHERE fecha >= current_date - 60 GROUP BY estado ORDER BY 2 DESC;
 */
const CENSO_PRODUCCION: ReadonlyArray<{ estado: string; pais: 'CO' | 'EC'; n: number }> = [
  // ── Colombia ──
  { estado: 'ENTREGADO', pais: 'CO', n: 362 },
  { estado: 'CANCELADO', pais: 'CO', n: 126 },
  { estado: 'DEVOLUCION', pais: 'CO', n: 121 },
  { estado: 'ARCHIVADO GHOST', pais: 'CO', n: 46 },
  { estado: 'PENDIENTE', pais: 'CO', n: 31 },
  { estado: 'DESPACHADA', pais: 'CO', n: 23 },
  { estado: 'NOVEDAD', pais: 'CO', n: 16 },
  { estado: 'RECLAME EN OFICINA', pais: 'CO', n: 8 },
  { estado: 'REEMPLAZADA', pais: 'CO', n: 7 },
  { estado: 'EN PUNTO DROOP', pais: 'CO', n: 4 },
  { estado: 'EN BODEGA TRANSPORTADORA', pais: 'CO', n: 4 },
  { estado: 'RECHAZADO', pais: 'CO', n: 4 },
  { estado: 'EN BODEGA DESTINO', pais: 'CO', n: 3 },
  { estado: 'EN REPARTO', pais: 'CO', n: 3 },
  { estado: 'PREPARADO PARA TRANSPORTADORA', pais: 'CO', n: 2 },
  { estado: 'EN TRANSPORTE', pais: 'CO', n: 1 },
  { estado: 'EN REEXPEDICION', pais: 'CO', n: 1 },
  { estado: 'EN ESPERA DE RUTA DOMESTICA', pais: 'CO', n: 1 },
  // ── Ecuador ── (con las tildes tal como las manda Dropi EC)
  { estado: 'ENTREGADO', pais: 'EC', n: 549 },
  { estado: 'REEMPLAZADA', pais: 'EC', n: 416 },
  { estado: 'CANCELADO', pais: 'EC', n: 404 },
  { estado: 'DEVOLUCION', pais: 'EC', n: 247 },
  { estado: 'ARCHIVADO GHOST', pais: 'EC', n: 101 },
  { estado: 'EN TRÁNSITO', pais: 'EC', n: 52 },
  { estado: 'ZONA DE ENTREGA', pais: 'EC', n: 44 },
  { estado: 'PARA RETIRO EN AGENCIA SERVIENTREGA', pais: 'EC', n: 35 },
  { estado: 'PENDIENTE', pais: 'EC', n: 30 },
  { estado: 'NOVEDAD', pais: 'EC', n: 24 },
  { estado: 'EN DISTRIBUCIÓN A CLIENTE', pais: 'EC', n: 16 },
  { estado: 'RECHAZADO', pais: 'EC', n: 8 },
  { estado: 'EN RUTA A CENTRO LOGISTICO', pais: 'EC', n: 7 },
  { estado: 'INGRESANDO OPERATIVO A', pais: 'EC', n: 7 },
  { estado: 'SOLUCION APROBADA', pais: 'EC', n: 6 },
  { estado: 'EN RUTA A CONCESION', pais: 'EC', n: 2 },
  { estado: 'INGRESANDO DE RECOLECCION A', pais: 'EC', n: 2 },
  { estado: 'EN PROCESO DE DEVOLUCION', pais: 'EC', n: 1 },
  { estado: 'INGRESANDO', pais: 'EC', n: 1 },
  { estado: 'NOVEDAD SOLUCIONADA', pais: 'EC', n: 1 },
  { estado: 'EN BODEGA ORIGEN', pais: 'EC', n: 1 },
  { estado: 'GUIA_GENERADA', pais: 'EC', n: 1 },
  { estado: 'POR RECOLECTAR', pais: 'EC', n: 1 },
  { estado: 'PREPARADO PARA TRANSPORTADORA', pais: 'EC', n: 1 },
  // Estados que solo aparecen fuera de la ventana de 60 días (censo completo,
  // toda la historia). Van igual: el tablero de Seguimiento mira 45 días, pero
  // Logística y los informes leen todo el histórico.
  { estado: 'ASIGNADO A', pais: 'EC', n: 3 },
  { estado: 'INDEMNIZADA', pais: 'CO', n: 1 },
  { estado: 'NOVEDAD SOLUCIONADA', pais: 'CO', n: 1 },
];

/**
 * El único estado de la base que cae en `otros` a propósito. Está acá para que
 * la lista de arriba se pueda leer como "esto es TODO lo que existe": si mañana
 * alguien mueve PENDIENTE CONFIRMACION a una fase del tablero, esta prueba
 * falla y obliga a pensarlo — quedaría duplicado con la cola de Confirmar.
 */
const NO_ES_FASE_DE_SEGUIMIENTO = 'PENDIENTE CONFIRMACION';

describe('segStatus contra el censo REAL de producción', () => {
  it('ningún estado que existe hoy en las dos tiendas cae en "Otros"', () => {
    const huerfanos = CENSO_PRODUCCION
      .filter((e) => classifySegEstado(e.estado) === 'otros')
      .map((e) => `${e.pais} "${e.estado}" (${e.n} pedidos)`);
    expect(huerfanos).toEqual([]);
  });

  it.each(CENSO_PRODUCCION)('$pais "$estado" se clasifica', ({ estado }) => {
    expect(classifySegEstado(estado)).not.toBe('otros');
  });

  // Las tildes de Ecuador ya tumbaron el tablero una vez: los matchers están
  // escritos sin tilde y Dropi EC las manda.
  it('las tildes de Ecuador no cambian la clasificación', () => {
    expect(classifySegEstado('EN TRÁNSITO')).toBe(classifySegEstado('EN TRANSITO'));
    expect(classifySegEstado('EN DISTRIBUCIÓN A CLIENTE')).toBe('reparto');
    expect(classifySegEstado('DEVOLUCIÓN')).toBe('devolucion');
  });

  // `matchTransito` acepta 'EN BODEGA <algo>' por prefijo. Eso solo es correcto
  // mientras las dos bodegas que NO son tránsito se resuelvan ANTES en la lista
  // de matchers. Si alguien reordena SEG_STATUS_MATCHERS, esto lo caza: un
  // pedido en la bodega de Dropi pintado como "va en camino" le hace creer a la
  // asesora que el paquete salió cuando ni siquiera se despachó.
  it('PENDIENTE CONFIRMACION sigue fuera del tablero, y en silencio', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => { warns.push(String(m)); };
    try {
      expect(classifySegEstado(NO_ES_FASE_DE_SEGUIMIENTO)).toBe('otros');
    } finally {
      console.warn = orig;
    }
    // Sin aviso: es conocido. El aviso se reserva para variantes nuevas de Dropi.
    expect(warns).toEqual([]);
  });

  it('un estado REALMENTE nuevo sí avisa', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => { warns.push(String(m)); };
    try {
      classifySegEstado('EN PLANETA MARTE ' + Math.floor(1e9 * 0.7654321));
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(1);
  });

  it('el prefijo "EN BODEGA" no se come a las bodegas que no son tránsito', () => {
    expect(classifySegEstado('EN BODEGA DROPI')).toBe('procesamiento');
    expect(classifySegEstado('EN BODEGA TRANSPORTADORA')).toBe('bodega_trans');
    // Y las que sí son tránsito, incluida la variante nueva de Colombia.
    expect(classifySegEstado('EN BODEGA DESTINO')).toBe('transito');
    expect(classifySegEstado('EN BODEGA ORIGEN')).toBe('transito');
    expect(classifySegEstado('EN BODEGA')).toBe('transito');
  });
});
