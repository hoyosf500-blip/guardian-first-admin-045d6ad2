import { describe, it, expect } from 'vitest';
import { evaluarCorrida, leerMotivos } from '@/hooks/useAutoPushHealth';

/**
 * Los mensajes son LITERALES de producción (2026-08-13). Importa que lo sean:
 * hoy mismo apareció una prueba que estaba en verde con un mensaje inventado
 * mientras el producto fallaba de verdad.
 */

const BLOQUEADO =
  '0 de 8 subidos — bloqueados: 8, duplicados: 0, errores: 0. Primeros motivos: ' +
  '#7472697999585→error: El token SÍ tiene read_products, pero este producto NO tiene NINGÚN metafield en | ' +
  '#7477143437537→error: El token SÍ tiene read_products, pero este producto NO tiene NINGÚN metafield en';

const CIUDAD =
  '0 de 2 subidos — bloqueados: 2, duplicados: 0, errores: 0. Primeros motivos: ' +
  '#7450828210401→error: Dropi no lista "CUSUBAMBA (PICHINCHA)" en su catálogo';

describe('salud del robot que sube pedidos de Shopify', () => {
  it('una corrida con pedidos bloqueados es una FALLA, no un aviso más', () => {
    const r = evaluarCorrida({ status: 'warn', error_message: BLOQUEADO, created_at: '2026-08-14T02:03:20Z' });
    expect(r.bloqueado).toBe(true);
    expect(r.cuantos).toBe(8);
    expect(r.cuando).toBeInstanceOf(Date);
  });

  it('muestra el motivo sin el prefijo técnico del id de Shopify', () => {
    const r = evaluarCorrida({ status: 'warn', error_message: BLOQUEADO });
    expect(r.motivos[0]).toMatch(/^El token SÍ tiene read_products/);
    expect(r.motivos[0]).not.toMatch(/#\d+/);
    expect(r.motivos).toHaveLength(2);
  });

  it('sirve para cualquier motivo, no solo el metafield', () => {
    // El 6-ago el bloqueo era otro: una ciudad fuera del catálogo de Dropi.
    // Si el aviso solo supiera del metafield, ese día habría estado mudo.
    const r = evaluarCorrida({ status: 'warn', error_message: CIUDAD });
    expect(r.bloqueado).toBe(true);
    expect(r.motivos[0]).toMatch(/CUSUBAMBA/);
  });

  it('"warn" SIN bloqueados NO es una falla', () => {
    // El robot marca warn también cuando no había nada que subir. Pintar eso de
    // rojo entrenaría a la asesora a ignorar el cartel, que es peor que no tenerlo.
    const r = evaluarCorrida({ status: 'warn', error_message: '0 de 0 subidos — bloqueados: 0, duplicados: 0, errores: 0.' });
    expect(r.bloqueado).toBe(false);
    expect(r.cuantos).toBe(0);
  });

  it('una corrida exitosa no dispara nada', () => {
    expect(evaluarCorrida({ status: 'success', error_message: '' }).bloqueado).toBe(false);
  });

  it('sin corridas todavía se calla', () => {
    expect(evaluarCorrida(null)).toEqual({ bloqueado: false, cuantos: 0, motivos: [], cuando: null });
  });

  it('un mensaje sin la sección de motivos no rompe', () => {
    const r = evaluarCorrida({ status: 'warn', error_message: 'bloqueados: 3' });
    expect(r.bloqueado).toBe(true);
    expect(r.motivos).toEqual([]);
  });

  it('leerMotivos ignora lo que viene antes de la etiqueta', () => {
    expect(leerMotivos('nada que ver')).toEqual([]);
  });
});
