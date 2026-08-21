import { describe, it, expect } from 'vitest';
import { ESCALERA, NO_ES_TRABAJO, siguienteAccion, type AccionKey } from './siguienteAccion';
import { SEG_LISTS, seMuestraComoChip } from './segLists';
import type { OrderData } from './orderUtils';

/**
 * GUARDIÁN — `/como-se-trabaja` no puede quedar desincronizada del sistema.
 *
 * El riesgo de una pantalla de ayuda es conocido: se escribe una vez, el código
 * cambia, y el manual sigue enseñando un protocolo que ya no existe. Ahí es
 * PEOR que no tener manual, porque la gente le cree y trabaja mal con
 * confianza.
 *
 * La defensa no es "acordarse de actualizarla": es que la pantalla no tenga
 * texto propio (saca todo de `ESCALERA` y del `queEs`/`queHacer` de cada lista)
 * y que estas pruebas fallen si alguien agrega un escalón o una lista sin
 * explicarlos.
 */

const base: OrderData = {
  idx: 0, id: '0', externalId: 'X-1', dbId: 'X-1',
  nombre: 'Test', phone: '3001234567', ciudad: 'BOGOTA', departamento: 'CUNDINAMARCA',
  producto: 'Test', productosDetalle: [], estado: 'PENDIENTE',
  fecha: '', fechaConf: '', dias: 0, diasConf: 0,
  valor: 100000, flete: 8000, costoProd: 30000, costoDev: 0, cantidad: 1,
  direccion: 'Cl 1 # 1-1', novedad: '', guia: '', transportadora: '',
  tags: '', tienda: '', email: '', novedadSol: false,
  barrio: '', complemento: '', documentoDestinatario: '', googlePlaceId: '',
  lat: null, lng: null, validationDecision: null, addressKind: null,
  missingFields: [], suggestedCustomerMessage: '', suggestedAddress: null,
  addressParsed: null, lastMovementAt: null,
};

describe('GUARDIÁN: el protocolo escrito es el protocolo que corre', () => {
  it('la escalera documentada cubre TODOS los escalones que la barra puede mostrar', () => {
    // Si mañana se agrega un escalón 7 y se olvida documentarlo, la pantalla lo
    // omitiría en silencio y la asesora nunca sabría que existe.
    const conEscalon: AccionKey[] = [
      'novedades', 'agencia', 'confirmar', 'detenidos', 'rescate', 'seguimiento',
    ];
    expect(ESCALERA.map((e) => e.key).sort()).toEqual([...conEscalon].sort());
  });

  it('está numerada de 1 a N, sin huecos ni repetidos', () => {
    expect(ESCALERA.map((e) => e.orden)).toEqual(
      Array.from({ length: ESCALERA.length }, (_, i) => i + 1),
    );
  });

  it('cada escalón dice qué hacer, no solo por qué', () => {
    // "Es urgente" sin "esto es lo que se hace" no le sirve a quien recién entra.
    for (const e of ESCALERA) {
      expect(e.nombre.length, e.key).toBeGreaterThan(3);
      expect(e.porque.length, e.key).toBeGreaterThan(20);
      expect(e.queHacer.length, e.key).toBeGreaterThan(60);
      expect(e.ruta.startsWith('/'), e.key).toBe(true);
    }
  });

  it('el "por qué" de la barra sale de la MISMA fuente que la ayuda', () => {
    // Una sola fuente: si divergen, la barra y la pantalla enseñan cosas
    // distintas del mismo escalón.
    const novedad = siguienteAccion({ workQueue: [], novedadesQueue: [base], segData: [] });
    expect(novedad.porque).toBe(ESCALERA.find((e) => e.key === 'novedades')!.porque);

    const confirmar = siguienteAccion({
      workQueue: [{ ...base, estado: 'PENDIENTE CONFIRMACION' }],
      novedadesQueue: [],
      segData: [],
    });
    expect(confirmar.porque).toBe(ESCALERA.find((e) => e.key === 'confirmar')!.porque);
  });

  it('toda lista que la asesora ve como chip está explicada', () => {
    // La regla que evita el caso "aparece un chip nuevo y nadie sabe qué es".
    const sinExplicar = SEG_LISTS
      .filter(seMuestraComoChip)
      .filter((l) => !l.queEs || !l.queHacer)
      .map((l) => l.slug);
    expect(sinExplicar).toEqual([]);
  });

  it('las listas que solo espejan una columna también están explicadas', () => {
    // No se muestran como chip, pero SÍ aparecen en la ayuda: son las que la
    // asesora ve como columnas del tablero y también necesita entender.
    const sinExplicar = SEG_LISTS.filter((l) => !l.queEs).map((l) => l.slug);
    expect(sinExplicar).toEqual([]);
  });

  it('se dice explícitamente qué NO es trabajo', () => {
    // Es la mitad menos obvia del protocolo: tener a alguien ocupado no sirve
    // si está ocupado en lo que no vence.
    expect(NO_ES_TRABAJO.length).toBeGreaterThanOrEqual(3);
    for (const n of NO_ES_TRABAJO) expect(n.porque.length).toBeGreaterThan(20);
  });
});
