import { describe, it, expect } from 'vitest';
import {
  paisNovedades, guiaNovedadPorPais, plantillaSolucionPorPais, paisTieneGuia,
  notasTransportadoraPorPais, reglasTransversalesPorPais, respuestaPublicada, fuenteDeFicha,
} from './porPais';
import { guiaOficialNovedad, plantillaSolucion } from '@/lib/dropiEcuador/logisticaOficial';
import type { GuiaPaisRaw } from './fichas';
import coRaw from '@/lib/dropiColombia/novedadesOficiales.json';
import gtRaw from '@/lib/dropiGuatemala/novedadesOficiales.json';

describe('novedades por país', () => {
  it('Ecuador sigue EXACTAMENTE igual: misma ficha y misma plantilla que antes', () => {
    const nov = 'NO RECLAMO EN OFICINA';
    expect(guiaNovedadPorPais('EC', nov, 'SERVIENTREGA')).toEqual(guiaOficialNovedad(nov, 'SERVIENTREGA'));
    const g = guiaOficialNovedad(nov, 'SERVIENTREGA');
    const pedido = { phone: '0991234567', nombre: 'Ana', direccion: 'x' };
    expect(plantillaSolucionPorPais('EC', g, pedido, 'SERVIENTREGA')).toEqual(plantillaSolucion(g, pedido, 'SERVIENTREGA'));
  });

  it('⛔ Colombia NO recibe la ficha de Ecuador «por parecida»: busca en SUS hojas', () => {
    // «NO RECLAMO EN OFICINA» es texto de Servientrega EC. En CO la hoja dice
    // «NO RECLAMÓ EN OFICINA» — y esa sí tiene que salir, con su fuente CO.
    const g = guiaNovedadPorPais('CO', 'NO RECLAMO EN OFICINA', 'SERVIENTREGA');
    expect(g?.novedad).toBe('NO RECLAMÓ EN OFICINA');
    expect(fuenteDeFicha(g)).toMatch(/scribd|dropi/i);
    expect(g).not.toEqual(guiaOficialNovedad('NO RECLAMO EN OFICINA', 'SERVIENTREGA'));
  });

  it('Colombia: una novedad de Coordinadora se resuelve con la ficha de Coordinadora, no de Servientrega', () => {
    const g = guiaNovedadPorPais('CO', 'DIRECCION INCOMPLETA', 'COORDINADORA');
    expect(g?.transportadora).toBe('COORDINADORA');
    expect(respuestaPublicada(g)).toBe(true);
    expect(g?.comoResponder).toMatch(/barrio/i);
  });

  it('⛔ sin transportadora reconocida no se adivina entre cinco hojas', () => {
    expect(guiaNovedadPorPais('CO', 'DIRECCION ERRADA', null)).toBeNull();
    expect(guiaNovedadPorPais('CO', 'DIRECCION ERRADA', '99MINUTOS')).toBeNull();
  });

  it('Veloces: Dropi publica el significado pero no cómo responder — y eso se dice, no se inventa', () => {
    const g = guiaNovedadPorPais('CO', 'DIRECCIÓN ERRADA', 'VELOCES');
    expect(g?.significado.length).toBeGreaterThan(10);
    expect(respuestaPublicada(g)).toBe(false);
    expect(g?.comoResponder).toBe('');
  });

  it('la plantilla colombiana usa el formato de Dropi CO, no el ecuatoriano', () => {
    const p = plantillaSolucionPorPais('CO', null, { phone: '3001234567', nombre: 'Luis', direccion: 'Cra 5 # 10-20' }, 'SERVIENTREGA');
    expect(p.origen).toBe('generica');
    expect(p.texto).toMatch(/^OFRECER A LA DIRECCIÓN Cra 5 # 10-20/);
    expect(p.texto).toContain('3001234567');
    expect(p.texto).not.toMatch(/me he comunicado/i);
    // Interrapidísimo: tope corto
    const pi = plantillaSolucionPorPais('CO', null, { phone: '3001234567', direccion: 'Cra 5 # 10-20' }, 'INTER RAPIDISIMO');
    expect(pi.maximo).toBe(120);
    expect(pi.texto.length).toBeLessThanOrEqual(120);
  });

  it('notas de la transportadora y reglas transversales de Dropi CO', () => {
    const n = notasTransportadoraPorPais('CO', 'Inter Rapidisimo');
    expect(n?.retiroEnOficina).toMatch(/15 d/);
    expect(reglasTransversalesPorPais('CO').map((f) => f.novedad).join(' ')).toMatch(/TIPS DE NOVEDADES/);
    expect(reglasTransversalesPorPais('EC')).toEqual([]);
  });

  it('Guatemala: Forza por estados publicados; Guatex casi nada, y se dice', () => {
    expect(guiaNovedadPorPais('GT', 'INCIDENCIA EN RUTA', 'FORZA DELIVERY')?.transportadora).toBe('FORZA');
    expect(guiaNovedadPorPais('GT', 'CUALQUIER COSA', 'GUATEX')).toBeNull();
    expect(paisTieneGuia('GT')).toBe(true);
  });

  it('un país desconocido o vacío cae a Colombia (el default histórico de la app)', () => {
    expect(paisNovedades(null)).toBe('CO');
    expect(paisNovedades('PE')).toBe('CO');
    expect(paisNovedades('ec')).toBe('EC');
  });
});

describe('⛔ guardián de los JSON de CO/GT: nada sin fuente, nada inferido', () => {
  const fichas = (raw: unknown) => Object.values((raw as GuiaPaisRaw).transportadoras).flatMap((t) => t.fichas);
  it.each([['CO', coRaw as unknown], ['GT', gtRaw as unknown]])('%s: toda ficha trae fuente y confianza válida', (_p, raw) => {
    for (const f of fichas(raw)) {
      expect(f.fuente, f.novedad).toMatch(/^https?:\/\/|scribd|youtube|xlsx|Plan de Vuelo/i);
      expect(['oficial', 'secundaria']).toContain(f.confianza);
      expect(f.responder).not.toMatch(/\(Inferido\)|se infiere|Sin gu[ií]a p[uú]blica/i);
    }
  });
  it('CO tiene las tres transportadoras con diccionario oficial completo', () => {
    for (const k of ['SERVIENTREGA', 'COORDINADORA', 'ENVIA']) {
      const t = (coRaw.transportadoras as Record<string, { fichas: { responder: string; confianza: string }[] }>)[k];
      expect(t.fichas.length).toBeGreaterThanOrEqual(15);
      expect(t.fichas.every((f) => f.confianza === 'oficial' && f.responder.length > 0)).toBe(true);
    }
  });
});
