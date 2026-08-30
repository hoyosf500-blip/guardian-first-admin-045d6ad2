import { describe, it, expect } from 'vitest';
import {
  paisNovedades, guiaNovedadPorPais, plantillaSolucionPorPais, paisTieneGuia,
} from './porPais';
import { guiaOficialNovedad, plantillaSolucion } from '@/lib/dropiEcuador/logisticaOficial';

describe('novedades por país', () => {
  it('Ecuador sigue EXACTAMENTE igual: misma ficha y misma plantilla que antes', () => {
    const nov = 'NO RECLAMO EN OFICINA';
    expect(guiaNovedadPorPais('EC', nov, 'SERVIENTREGA')).toEqual(guiaOficialNovedad(nov, 'SERVIENTREGA'));
    const g = guiaOficialNovedad(nov, 'SERVIENTREGA');
    const pedido = { phone: '0991234567', nombre: 'Ana', direccion: 'x' };
    expect(plantillaSolucionPorPais('EC', g, pedido, 'SERVIENTREGA')).toEqual(plantillaSolucion(g, pedido, 'SERVIENTREGA'));
  });

  it('⛔ Colombia NO recibe la ficha de Ecuador «por parecida»', () => {
    // La misma novedad que en EC tiene ficha, en CO devuelve null: los plazos,
    // agencias e intentos de Servientrega Colombia no son los de Ecuador.
    expect(guiaNovedadPorPais('CO', 'NO RECLAMO EN OFICINA', 'SERVIENTREGA')).toBeNull();
    expect(guiaNovedadPorPais('GT', 'DEVUELTO DE', 'CARGO EXPRESO')).toBeNull();
    expect(paisTieneGuia('CO')).toBe(false);
    expect(paisTieneGuia('EC')).toBe(true);
  });

  it('pero SÍ recibe la plantilla de solución, con el teléfono real y huecos', () => {
    const p = plantillaSolucionPorPais('CO', null, { phone: '3001234567', nombre: 'Luis' }, 'INTERRAPIDISIMO');
    expect(p.origen).toBe('generica');
    expect(p.texto).toContain('3001234567');
    expect(p.texto).toContain('____');
    expect(p.maximo).toBe(500);
  });

  it('un país desconocido o vacío cae a Colombia (el default histórico de la app)', () => {
    expect(paisNovedades(null)).toBe('CO');
    expect(paisNovedades('PE')).toBe('CO');
    expect(paisNovedades('ec')).toBe('EC');
  });
});
