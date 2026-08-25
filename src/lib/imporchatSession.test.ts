import { describe, it, expect } from 'vitest';
// Cruza el límite a la lógica pura de la edge function (patrón de la casa:
// ventanaWhatsapp, plantillasMeta). Solo se importa lo que NO toca la red.
import { necesitaRenovar, decodeJwtExp, MARGEN_RENOVACION_HORAS } from '../../supabase/functions/_shared/imporchatSession';

const HORA = 3600_000;
const ahora = 1_756_000_000_000; // un "ahora" fijo, en ms

describe('necesitaRenovar — cuándo pedir una llave nueva', () => {
  it('NO renueva si falta mucho para el vencimiento', () => {
    const dentroDe5Dias = Math.floor((ahora + 5 * 24 * HORA) / 1000);
    expect(necesitaRenovar(dentroDe5Dias, ahora)).toBe(false);
  });

  it('SÍ renueva si vence dentro del margen (48 h)', () => {
    const dentroDe30h = Math.floor((ahora + 30 * HORA) / 1000);
    expect(necesitaRenovar(dentroDe30h, ahora)).toBe(true);
  });

  it('el borde exacto del margen: justo antes renueva, justo después no', () => {
    const justoDentro = Math.floor((ahora + (MARGEN_RENOVACION_HORAS - 1) * HORA) / 1000);
    const justoFuera = Math.floor((ahora + (MARGEN_RENOVACION_HORAS + 1) * HORA) / 1000);
    expect(necesitaRenovar(justoDentro, ahora)).toBe(true);
    expect(necesitaRenovar(justoFuera, ahora)).toBe(false);
  });

  it('una llave YA vencida se renueva', () => {
    const ayer = Math.floor((ahora - 24 * HORA) / 1000);
    expect(necesitaRenovar(ayer, ahora)).toBe(true);
  });

  // ⛔ Sin exp legible NO se asume que está viva: se renueva. Una llave muerta
  // que se cree viva apaga TODO ImporChat sin aviso — es justo lo que este
  // módulo existe para evitar.
  it('exp nulo se trata como "hay que renovar"', () => {
    expect(necesitaRenovar(null, ahora)).toBe(true);
  });
});

describe('decodeJwtExp', () => {
  it('saca el exp de un JWT sin verificar firma', () => {
    // { "exp": 1788258317 } en base64url, con header y firma de relleno.
    const payload = btoa(JSON.stringify({ exp: 1788258317 })).replace(/=/g, '');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.firma`;
    expect(decodeJwtExp(jwt)).toBe(1788258317);
  });

  it('devuelve null con basura en vez de tirar', () => {
    expect(decodeJwtExp('no-es-un-jwt')).toBeNull();
    expect(decodeJwtExp('')).toBeNull();
    expect(decodeJwtExp('a.b.c')).toBeNull();
  });
});
