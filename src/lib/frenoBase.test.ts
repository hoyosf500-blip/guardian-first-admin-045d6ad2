import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registrarRespuesta, abierto, estado, onCambio, esSintoma, _reiniciarParaPruebas,
  SINTOMAS_PARA_ABRIR, ABIERTO_MS, VENTANA_MS, LENTA_MS,
} from './frenoBase';

/**
 * El cortacircuitos de la base. Ver la cabecera de `frenoBase.ts` para la
 * mañana del 5-sep-2026 que lo hizo necesario.
 */
describe('frenoBase — el cortacircuitos de la base', () => {
  let t = 1_000_000;
  const reloj = () => t;
  beforeEach(() => { t = 1_000_000; _reiniciarParaPruebas(reloj); });
  afterEach(() => { _reiniciarParaPruebas(); });

  it('arranca cerrado y una respuesta sana no lo mueve', () => {
    registrarRespuesta({ ms: 120, status: 200 });
    registrarRespuesta({ ms: 900, status: 200 });
    expect(abierto()).toBe(false);
    expect(estado().sintomas).toBe(0);
  });

  it('un 4xx NO es síntoma: es un error de la app, no de la base', () => {
    for (let i = 0; i < 10; i++) registrarRespuesta({ ms: 50, status: 401 });
    for (let i = 0; i < 10; i++) registrarRespuesta({ ms: 50, status: 404 });
    expect(abierto()).toBe(false);
    expect(esSintoma({ ms: 50, status: 403 })).toBeNull();
  });

  it('se abre con 3 síntomas en la ventana, no con menos', () => {
    registrarRespuesta({ ms: 200, status: 504 });
    registrarRespuesta({ ms: 200, status: 503 });
    expect(abierto()).toBe(false);
    registrarRespuesta({ ms: LENTA_MS + 1, status: 200 });
    expect(abierto()).toBe(true);
    expect(estado().sintomas).toBe(SINTOMAS_PARA_ABRIR);
  });

  it('los tres tipos de síntoma cuentan: 5xx, red caída y respuesta lenta', () => {
    expect(esSintoma({ ms: 10, status: 500 })).toMatch(/500/);
    expect(esSintoma({ ms: 10, fallo: true })).toMatch(/red/);
    expect(esSintoma({ ms: LENTA_MS + 500, status: 200 })).toMatch(/tardó/);
    expect(esSintoma({ ms: LENTA_MS - 1, status: 200 })).toBeNull();
  });

  it('los síntomas viejos se olvidan: 3 repartidos en más de un minuto no abren', () => {
    registrarRespuesta({ ms: 10, status: 500 });
    t += VENTANA_MS / 2;
    registrarRespuesta({ ms: 10, status: 500 });
    t += VENTANA_MS / 2 + 1; // el primero ya salió de la ventana
    registrarRespuesta({ ms: 10, status: 500 });
    expect(abierto()).toBe(false);
  });

  it('se cierra solo cuando pasa el tiempo sin síntomas nuevos', () => {
    for (let i = 0; i < 3; i++) registrarRespuesta({ ms: 10, status: 502 });
    expect(abierto()).toBe(true);
    t += ABIERTO_MS - 1;
    expect(abierto()).toBe(true);
    t += 2;
    expect(abierto()).toBe(false);
  });

  it('se EXTIENDE mientras sigan llegando síntomas: no parpadea abierto/cerrado a mitad de la caída', () => {
    for (let i = 0; i < 3; i++) registrarRespuesta({ ms: 10, status: 502 });
    const hasta1 = estado().hasta!;
    t += ABIERTO_MS / 2;
    registrarRespuesta({ ms: 10, status: 504 });
    expect(estado().hasta!).toBeGreaterThan(hasta1);
    expect(estado().desde).toBe(1_000_000); // la apertura original se conserva
  });

  it('avisa una sola vez al abrir, no en cada síntoma', () => {
    let avisos = 0;
    onCambio(() => { avisos++; });
    for (let i = 0; i < 8; i++) registrarRespuesta({ ms: 10, status: 500 });
    expect(abierto()).toBe(true);
    expect(avisos).toBe(1);
  });

  it('el motivo dice qué lo abrió, para que el aviso hable claro', () => {
    registrarRespuesta({ ms: 10, status: 500 });
    registrarRespuesta({ ms: 10, status: 500 });
    registrarRespuesta({ ms: 12_300, status: 200 });
    expect(estado().motivo).toMatch(/tardó 12 s/);
  });
});
