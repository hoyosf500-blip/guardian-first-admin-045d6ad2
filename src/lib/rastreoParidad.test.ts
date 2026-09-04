import { describe, it, expect } from 'vitest';
import { CARRIER_TRACK, CARRIER_TRACK_EC, CARRIER_TRACK_GT } from './constants';
import { getTrackingUrl } from './orderUtils';
import { RASTREO_CO, RASTREO_EC, RASTREO_GT, urlRastreo, linkRastreoConGuia } from '../../supabase/functions/_shared/rastreo';

/**
 * GUARDIÁN: las tablas de rastreo del frontend y del servidor son la MISMA.
 *
 * `_shared/rastreo.ts` existe porque las edge functions no pueden importar
 * `src/`. Es una copia a propósito, y una copia se desincroniza sola: alguien
 * agrega una transportadora en `constants.ts` y el responder automático de
 * WhatsApp le manda al cliente un link viejo o ninguno. Esta prueba lo impide.
 */
describe('rastreo: la copia del servidor es idéntica a la del frontend', () => {
  it('las tres tablas por país son iguales clave por clave', () => {
    expect(RASTREO_CO).toEqual(CARRIER_TRACK);
    expect(RASTREO_EC).toEqual(CARRIER_TRACK_EC);
    expect(RASTREO_GT).toEqual(CARRIER_TRACK_GT);
  });

  it('urlRastreo da lo mismo que getTrackingUrl para las transportadoras reales', () => {
    const casos: Array<[string, string]> = [
      ['LAARCOURIER', 'EC'], ['SERVIENTREGA', 'EC'], ['GINTRACOM', 'EC'], ['LAAR EXPRESS', 'EC'],
      ['SERVIENTREGA', 'CO'], ['INTERRAPIDISIMO', 'CO'], ['ENVIA', 'CO'], ['TCC', 'CO'],
      ['SERVIENTREGA', 'GT'], ['DESCONOCIDA', 'EC'], ['', 'CO'],
    ];
    for (const [t, cc] of casos) {
      expect(urlRastreo(t, 'LC55165087', cc), `${t}/${cc}`).toBe(getTrackingUrl(t, 'LC55165087', cc));
    }
  });

  it('linkRastreoConGuia solo devuelve links que llevan la guía adentro', () => {
    expect(linkRastreoConGuia('LAARCOURIER', 'LC1', 'EC')).toBe('https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=LC1');
    // Portada sin guía → nada (mejor sin link que un "sígalo aquí" que no sigue).
    expect(linkRastreoConGuia('GINTRACOM', '123', 'EC')).toBeNull();
    expect(linkRastreoConGuia('LAARCOURIER', '', 'EC')).toBeNull();
    expect(linkRastreoConGuia('SERVIENTREGA', '123', 'GT')).toBeNull();
  });
});
