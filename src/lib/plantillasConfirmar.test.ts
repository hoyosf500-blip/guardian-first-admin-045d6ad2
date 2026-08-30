import { describe, it, expect } from 'vitest';
import { classifySegEstado, esColaDeConfirmacion } from './segStatus';
import { ordenarParaFase, type PlantillaMeta } from './plantillasMeta';
import { agruparPlantillas, faseParaPlantillas } from './accionSeguimiento';
import { plantillasPara } from './plantillasChat';

/**
 * ⛔ GUARDIÁN — "en Confirmar no salen primero las plantillas de confirmación"
 * (reportado por el dueño el 30-ago-2026).
 *
 * La cadena que fallaba, medida ejecutando el código:
 *  1. `PENDIENTE CONFIRMACION` clasifica como `otros` — a propósito: no es una
 *     fase de Seguimiento, es la cola de Confirmar (`OTROS_ESPERADOS`).
 *  2. `POR_FASE` (plantillasMeta) no tenía `otros` → sin regex de fase, el
 *     orden salía ALFABÉTICO: confirmacion, en_transito, novedad,
 *     reconfirmacion… con las dos de confirmar separadas por las de logística.
 *  3. `GRUPO_POR_FASE` (accionSeguimiento) tampoco tenía `otros` → el grupo
 *     "Confirmación del pedido" salía CUARTO y sin marcar como el de la fase.
 *  4. `plantillasPara` caía al fallback genérico "¿todo bien con la entrega?"
 *     sobre un pedido que ni siquiera está despachado.
 *
 * El comentario del código afirmaba que ese estado caía en `procesamiento`.
 * Era falso, y por eso el arreglo anterior (27-ago) no sirvió: cambió una
 * clave muerta por otra que tampoco dispara. De ahí que esta prueba EJECUTE
 * la clasificación en vez de confiar en lo que dice un comentario.
 */
describe('⛔ Confirmar: las plantillas de confirmación van primero', () => {
  const ESTADO = 'PENDIENTE CONFIRMACION';
  const falsas = [
    { nombre: 'confirmacion_pedido_k1', categoria: 'UTILITY' },
    { nombre: 'reconfirmacion_k2', categoria: 'UTILITY' },
    { nombre: 'retiro_agencia_disponible_k1', categoria: 'UTILITY' },
    { nombre: 'novedad_k1', categoria: 'UTILITY' },
    { nombre: 'en_transito_k1', categoria: 'UTILITY' },
    { nombre: 'remarketing_descuento_k1', categoria: 'MARKETING' },
  ] as unknown as PlantillaMeta[];

  it('la cola de Confirmar sigue clasificando como «otros» (si esto cambia, revisar los mapas)', () => {
    expect(classifySegEstado(ESTADO)).toBe('otros');
    // Y NO es lo mismo que 'PENDIENTE' a secas, que sí es una fase real:
    expect(classifySegEstado('PENDIENTE')).toBe('procesamiento');
  });

  it('ordenarParaFase pone las dos de confirmación arriba, juntas', () => {
    const orden = ordenarParaFase(falsas, faseParaPlantillas(ESTADO)).map((p) => p.nombre);
    expect(orden.slice(0, 2).sort()).toEqual(['confirmacion_pedido_k1', 'reconfirmacion_k2']);
    // lo que pasaba antes: en_transito y novedad se metían en el medio
    expect(orden.indexOf('en_transito_k1')).toBeGreaterThan(1);
  });

  it('⛔ con classifySegEstado a secas NO funciona — por eso existe faseParaPlantillas', () => {
    // Este es el error exacto que hubo que arreglar; si alguien vuelve a pasar
    // la fase del tablero, esta prueba lo deja en evidencia.
    const conFaseCruda = ordenarParaFase(falsas, classifySegEstado(ESTADO)).map((p) => p.nombre);
    expect(conFaseCruda.indexOf('reconfirmacion_k2')).toBeGreaterThan(1);
    expect(faseParaPlantillas(ESTADO)).toBe('procesamiento');
  });

  it('el grupo «Confirmación del pedido» sale PRIMERO y marcado como el de la fase', () => {
    const grupos = agruparPlantillas(falsas, ESTADO);
    expect(grupos[0].titulo).toBe('Confirmación del pedido');
    expect(grupos[0].deLaFase).toBe(true);
  });

  it('los arranques de chat son de confirmar, no de entrega', () => {
    const t = plantillasPara(ESTADO, 'Ana');
    expect(t.length).toBeGreaterThanOrEqual(3);
    const todo = t.map((p) => `${p.titulo} ${p.texto}`).join(' | ').toLowerCase();
    expect(todo).toMatch(/confirmar|confirmas/);
    // el fallback genérico hablaba de una entrega que todavía no existe
    expect(t.map((p) => p.titulo)).not.toContain('Cómo va tu pedido');
    // y saluda con el nombre del cliente
    expect(todo).toContain('ana');
  });

  it('⛔ un estado que Dropi invente NO se hace pasar por la cola de Confirmar', () => {
    // Cae en el mismo cajón `otros`, pero no es lo mismo: a un pedido que
    // podría estar en tránsito no se le ofrecen plantillas de confirmación.
    const inventado = 'ESTADO QUE NADIE CLASIFICO TODAVIA';
    expect(classifySegEstado(inventado)).toBe('otros');
    expect(esColaDeConfirmacion(inventado)).toBe(false);
    expect(agruparPlantillas(falsas, inventado).every((g) => !g.deLaFase)).toBe(true);
    // …y la cola de Confirmar sí lo es, escríbase como se escriba:
    expect(esColaDeConfirmacion('pendiente confirmacion')).toBe(true);
    expect(esColaDeConfirmacion('PENDIENTE CONFIRMACIÓN')).toBe(true);
  });
});
