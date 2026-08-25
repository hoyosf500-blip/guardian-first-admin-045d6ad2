import { describe, it, expect } from 'vitest';
import { motivoEdge, cuerpoDelError } from './errorEdge';

const SIN_DESPLEGAR = 'Todavía no está activado en el servidor.';
const POR_DEFECTO = 'No se pudo enviar';

describe('motivoEdge — la asesora nunca ve inglés', () => {
  // El caso REAL medido el 25-ago-2026 con la función recién subida: el
  // navegador corta el fetch sin cuerpo y supabase-js devuelve este texto.
  // Antes se colaba tal cual a la pantalla.
  it('"Failed to send a request to the Edge Function" ⇒ falta desplegar', () => {
    const r = motivoEdge({ message: 'Failed to send a request to the Edge Function' }, null, SIN_DESPLEGAR, POR_DEFECTO);
    expect(r.detalle).toBe(SIN_DESPLEGAR);
    expect(r.sinConfig).toBe(false);
  });

  it('el otro texto genérico de supabase-js tampoco pasa', () => {
    for (const m of ['Edge Function returned a non-2xx status code', 'Failed to fetch', 'NetworkError when attempting to fetch resource']) {
      expect(motivoEdge({ message: m }, null, SIN_DESPLEGAR, POR_DEFECTO).detalle, m).toBe(SIN_DESPLEGAR);
    }
  });

  it('un error sin mensaje tampoco deja a la pantalla muda', () => {
    expect(motivoEdge({}, null, SIN_DESPLEGAR, POR_DEFECTO).detalle).toBe(SIN_DESPLEGAR);
    expect(motivoEdge(null, null, SIN_DESPLEGAR, POR_DEFECTO).detalle).toBe(SIN_DESPLEGAR);
  });

  // ⛔ Lo importante: el motivo que escribió la función SIEMPRE gana. Es el
  // único que sabe si la ventana venció, si falta un dato o si la credencial
  // se murió — y es lo que decide qué hace la asesora después.
  it('el cuerpo de la función manda sobre el mensaje genérico', () => {
    const r = motivoEdge(
      { message: 'Edge Function returned a non-2xx status code' },
      { error: 'Faltan datos de la plantilla (4)' },
      SIN_DESPLEGAR, POR_DEFECTO,
    );
    expect(r.detalle).toBe('Faltan datos de la plantilla (4)');
  });

  it('NOT_FOUND del gateway también se traduce', () => {
    expect(motivoEdge({ message: 'x' }, { code: 'NOT_FOUND' }, SIN_DESPLEGAR, POR_DEFECTO).detalle).toBe(SIN_DESPLEGAR);
  });

  it('sin_config se marca aparte: esa pantalla no se dibuja', () => {
    const r = motivoEdge({}, { sin_config: true, error: 'Esta tienda no tiene ImporChat configurado' }, SIN_DESPLEGAR, POR_DEFECTO);
    expect(r.sinConfig).toBe(true);
    expect(r.detalle).toBe('Esta tienda no tiene ImporChat configurado');
  });

  it('un mensaje propio y legible se respeta', () => {
    const r = motivoEdge({ message: 'La credencial de ImporChat venció' }, null, SIN_DESPLEGAR, POR_DEFECTO);
    expect(r.detalle).toBe('La credencial de ImporChat venció');
  });

  it('nunca devuelve vacío', () => {
    for (const e of [null, undefined, {}, { message: '' }, { message: '   ' }]) {
      expect(motivoEdge(e, null, SIN_DESPLEGAR, POR_DEFECTO).detalle.length).toBeGreaterThan(0);
    }
  });
});

describe('cuerpoDelError', () => {
  it('lee el JSON cuando está', async () => {
    const e = { context: { json: async () => ({ error: 'ventana vencida' }) } };
    expect(await cuerpoDelError(e)).toEqual({ error: 'ventana vencida' });
  });

  it('devuelve null sin lanzar cuando no hay cuerpo o no es JSON', async () => {
    expect(await cuerpoDelError({})).toBeNull();
    expect(await cuerpoDelError(null)).toBeNull();
    expect(await cuerpoDelError({ context: {} })).toBeNull();
    expect(await cuerpoDelError({ context: { json: async () => { throw new Error('no es JSON'); } } })).toBeNull();
  });
});
