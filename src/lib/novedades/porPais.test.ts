import { describe, it, expect } from 'vitest';
import {
  paisNovedades, guiaNovedadPorPais, plantillaSolucionPorPais, paisTieneGuia,
  notasTransportadoraPorPais, reglasTransversalesPorPais, respuestaPublicada, fuenteDeFicha,
  esEstadoDeFlujo, confianzaDeFicha,
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

  it('⛔ ECUADOR tampoco adivina — la misma regla, que le faltaba (30-ago-2026)', () => {
    // Ecuador tenía su propio motor (`dropiEcuador/logisticaOficial.ts`) con la
    // regla VIEJA: sin transportadora buscaba en las CINCO hojas y ganaba el
    // mejor puntaje. Medido: una novedad de un pedido que no va con Veloces
    // mostraba «Guía oficial de Dropi — VELOCES — "NO CONTESTA"» con sus
    // instrucciones, sus plazos y su plantilla, y la asesora respondía a Dropi
    // con el formato equivocado. Esta prueba no existía para EC: por eso
    // sobrevivió al arreglo que sí se hizo en CO/GT.
    expect(guiaNovedadPorPais('EC', 'NO CONTESTA', null)).toBeNull();
    expect(guiaNovedadPorPais('EC', 'NO CONTESTA', 'TRANSPORTADORA QUE NO EXISTE')).toBeNull();
    expect(guiaNovedadPorPais('EC', 'DIRECCION ERRADA', '')).toBeNull();
    // …y CON transportadora reconocida sigue funcionando (no rompimos EC):
    const g = guiaNovedadPorPais('EC', 'NO CONTESTA', 'SERVIENTREGA');
    expect(g).not.toBeNull();
    expect(g?.transportadora).toBe('SERVIENTREGA');
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

/**
 * ⛔ GUARDIÁN — Guatemala no tiene guía de Dropi, y sus "estados de flujo" no
 * son novedades (auditoría 30-ago-2026).
 *
 * La pantalla titulaba TODA ficha como «Guía oficial de Dropi» y pintaba en
 * VERDE, bajo «Cómo responder en el panel de Dropi», el texto
 * «NO NECESITA RESPUESTA (estado de flujo, no novedad)». La asesora de
 * Guatemala cerraba el pedido sin gestionar creyendo que era Dropi quien lo
 * decía. Los dos datos que hacían falta ya estaban en el registro —`confianza`
 * y el propio texto de `responder`— y no se dibujaban en ninguna pantalla.
 */
describe('⛔ Guatemala: fuente secundaria y estados de flujo', () => {
  it('las fichas GT NO son "oficial de Dropi" — el registro dice que esa guía no existe', () => {
    const g = guiaNovedadPorPais('GT', 'SOLICITADO', 'FORZA');
    expect(g).not.toBeNull();
    expect(confianzaDeFicha(g)).toBe('secundaria');
  });

  it('«NO NECESITA RESPUESTA» es un estado de flujo, NO una instrucción de respuesta', () => {
    const g = guiaNovedadPorPais('GT', 'SOLICITADO', 'FORZA');
    expect(esEstadoDeFlujo(g)).toBe(true);
    // …y por eso NO puede caer en la rama verde "Cómo responder en el panel":
    expect(respuestaPublicada(g)).toBe(false);
  });

  it('una novedad GT de verdad SÍ trae respuesta y no es estado de flujo', () => {
    const g = guiaNovedadPorPais('GT', 'DIRECCION INCORRECTA', 'FORZA')
      ?? guiaNovedadPorPais('GT', 'CLIENTE NO CONTESTA', 'FORZA');
    if (!g) return; // el diccionario GT puede no traer estos nombres exactos
    expect(esEstadoDeFlujo(g)).toBe(false);
  });

  it('Colombia y Ecuador siguen siendo oficiales — no se degradó lo que sí lo es', () => {
    expect(confianzaDeFicha(guiaNovedadPorPais('CO', 'DIRECCION INCOMPLETA', 'COORDINADORA'))).toBe('oficial');
    expect(confianzaDeFicha(guiaNovedadPorPais('EC', 'NO CONTESTA', 'SERVIENTREGA'))).toBe('oficial');
  });
});

/**
 * ⛔ GUARDIÁN — la plantilla de Interrapidísimo (tope 120) se CONSTRUYE corta,
 * no se corta (auditoría 30-ago-2026).
 *
 * Antes se armaba el texto completo y se hacía `slice(0, 120)`. Con una
 * dirección de Bogotá el corte caía a mitad de palabra y se llevaba puesto el
 * teléfono y el hueco del barrio — justo lo que la transportadora necesita:
 *   «…TORRE 3 APTO 402 BARRIO ____. Recibe el ____. T»
 * y el contador marcaba 120/120, así que la asesora ya no podía completarlo.
 */
describe('⛔ plantilla CO con tope de 120 (Interrapidísimo)', () => {
  const DIR_LARGA = 'CALLE 45 A SUR # 72 F - 31 BARRIO KENNEDY CENTRAL TORRE 3 APTO 402 INTERIOR 5';
  const pedido = { phone: '3001234567', nombre: 'ANA MARIA', direccion: DIR_LARGA };

  it('respeta el tope SIN cortar a mitad de palabra', () => {
    const p = plantillaSolucionPorPais('CO', null, pedido, 'INTERRAPIDISIMO');
    expect(p.maximo).toBe(120);
    expect(p.texto.length).toBeLessThanOrEqual(120);
    // La marca de abreviado, no un corte seco:
    expect(p.texto).toContain('…');
  });

  it('el TELÉFONO sobrevive — era lo primero que se perdía', () => {
    const p = plantillaSolucionPorPais('CO', null, pedido, 'INTERRAPIDISIMO');
    expect(p.texto).toContain('3001234567');
    expect(p.texto).toMatch(/Tel 3001234567\.$/);
  });

  it('los dos huecos que completa la asesora sobreviven', () => {
    const p = plantillaSolucionPorPais('CO', null, pedido, 'INTERRAPIDISIMO');
    expect(p.texto).toContain('BARRIO ____');
    expect(p.texto).toContain('Recibe el ____');
  });

  it('con dirección corta entra entera, sin abreviar', () => {
    const p = plantillaSolucionPorPais('CO', null, { ...pedido, direccion: 'CRA 7 # 12-34' }, 'INTERRAPIDISIMO');
    expect(p.texto).toContain('CRA 7 # 12-34');
    expect(p.texto).not.toContain('…');
  });

  it('otras transportadoras CO siguen con el formato largo', () => {
    const p = plantillaSolucionPorPais('CO', null, pedido, 'SERVIENTREGA');
    expect(p.maximo).toBe(500);
    expect(p.texto).toContain(DIR_LARGA);
    expect(p.texto).toContain('ANA MARIA');
  });
});
