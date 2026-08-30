import { describe, it, expect } from 'vitest';
import { plantillasPara } from './plantillasChat';
import { classifySegEstado } from './segStatus';
import { accionPrincipal } from './accionSeguimiento';

/**
 * ⛔ GUARDIÁN — el botón dice lo que le va a llegar al cliente, Y LO MANDA.
 *
 * Es la regla que este módulo vino a poner, y estaba rota en tres fases:
 * `guia`, `bodega_trans` y `procesamiento` no tenían rama en `plantillasPara`,
 * así que caían al catch-all *"¿todo bien con la entrega?"*.
 *
 * `AccionPrincipal` toma `plantillasPara(...)[0].texto` como el mensaje del
 * botón, lo manda, y registra `accion.gestion` — que para esas fases es
 * «Envié la guía» / «Avisé que está en proceso». O sea: el botón prometía una
 * cosa, mandaba otra, y firmaba la primera en la bitácora.
 */
describe('⛔ las fases con guía mandan LA GUÍA, no un genérico', () => {
  const GENERICO = 'Cómo va tu pedido';
  const datos = { guia: 'V123456789', transportadora: 'SERVIENTREGA' };

  it('GUIA GENERADA arranca con la guía de verdad, no con «¿todo bien con la entrega?»', () => {
    expect(classifySegEstado('GUIA GENERADA')).toBe('guia');
    const [primera] = plantillasPara('GUIA GENERADA', 'Ana', datos);
    expect(primera.titulo).not.toBe(GENERICO);
    expect(primera.texto).toContain('V123456789');
    expect(primera.texto).toContain('SERVIENTREGA');
    expect(primera.texto).toContain('Ana');
  });

  it('sin guía NO se promete una guía — se dice lo que sí se sabe', () => {
    const [primera] = plantillasPara('GUIA GENERADA', 'Ana', { transportadora: 'SERVIENTREGA' });
    expect(primera.texto).not.toMatch(/número de guía es\s*\./i);
    expect(primera.texto).toMatch(/en cuanto tenga el número de guía/i);
    expect(primera.titulo).not.toBe(GENERICO);
  });

  it('procesamiento tampoco cae al genérico', () => {
    expect(classifySegEstado('PENDIENTE')).toBe('procesamiento');
    const [primera] = plantillasPara('PENDIENTE', 'Ana');
    expect(primera.titulo).not.toBe(GENERICO);
    expect(primera.texto).toMatch(/preparando|prepar/i);
  });

  /**
   * El invariante de verdad: si una fase tiene un botón con `gestion` propia,
   * su arranque NO puede ser el catch-all — porque ese arranque es lo que el
   * botón manda mientras firma esa gestión.
   */
  it('⛔ ninguna fase con acción propia puede arrancar con el texto genérico', () => {
    const EJEMPLO: Record<string, string> = {
      procesamiento: 'PENDIENTE',
      guia: 'GUIA GENERADA',
      bodega_trans: 'EN BODEGA TRANSPORTADORA',
      transito: 'EN TRANSITO',
      reparto: 'EN REPARTO',
      oficina: 'EN OFICINA',
      novedad: 'NOVEDAD',
      devolucion: 'DEVOLUCION',
    };
    const sinCubrir: string[] = [];
    for (const [fase, estado] of Object.entries(EJEMPLO)) {
      const accion = accionPrincipal(estado);
      if (!accion) continue;
      const [primera] = plantillasPara(estado, 'Ana', datos);
      if (primera.titulo === GENERICO) sinCubrir.push(`${fase} → firma «${accion.gestion}»`);
    }
    expect(sinCubrir, `estas fases mandan el genérico mientras firman su propia gestión: ${sinCubrir.join(', ')}`).toEqual([]);
  });

  it('un estado que Dropi invente SÍ cae al genérico — ahí es lo correcto', () => {
    const [primera] = plantillasPara('ESTADO QUE NADIE CLASIFICO', 'Ana');
    expect(primera.titulo).toBe(GENERICO);
  });
});
