import { describe, it, expect } from 'vitest';
import {
  mensajeSeguimiento,
  fechaLimiteAgencia,
  primerNombre,
  urlWhatsApp,
  DIAS_PARA_RECLAMAR,
  type MensajeSeguimientoInput,
} from './mensajeSeguimiento';
import type { SegStatusKey } from './segStatus';

const base: MensajeSeguimientoInput = {
  nombre: 'MARIA FERNANDA GOMEZ',
  producto: 'Reloj Smart X9',
  fase: 'oficina',
  ciudad: 'Guayaquil',
  transportadora: 'LAARCOURIER',
  guia: '9988776',
  trackingUrl: 'https://rastreo.example/9988776',
  valorTexto: '$45.00',
  lastMovementAt: '2026-08-18T14:00:00Z',
};

describe('primerNombre', () => {
  it('toma solo el primero y lo capitaliza (Dropi manda TODO EN MAYÚSCULA)', () => {
    expect(primerNombre('MARIA FERNANDA GOMEZ')).toBe('Maria');
    expect(primerNombre('juan')).toBe('Juan');
  });

  it('sin nombre usable devuelve vacío (para caer al saludo genérico)', () => {
    expect(primerNombre('')).toBe('');
    expect(primerNombre(null)).toBe('');
    expect(primerNombre('   ')).toBe('');
    // Una inicial suelta ("J Pérez") no es un nombre con el que saludar.
    expect(primerNombre('J Pérez')).toBe('');
  });
});

describe('fechaLimiteAgencia', () => {
  it('suma DIAS_PARA_RECLAMAR a la llegada', () => {
    const r = fechaLimiteAgencia('2026-08-18T14:00:00Z');
    expect(r).toBeTruthy();
    // 18-ago + 5 = 23-ago-2026 (domingo). Se comprueba el día, no el formato
    // exacto del locale, que puede variar entre entornos.
    expect(r).toMatch(/23/);
  });

  it('el plazo que damos es MENOR al que retiene la transportadora (~7d)', () => {
    // Si alguien sube esta constante a 7+ el mensaje manda al cliente el mismo
    // día en que la transportadora ya puede haberlo devuelto.
    expect(DIAS_PARA_RECLAMAR).toBeLessThan(7);
  });

  it('sin fecha o con fecha corrupta devuelve null — NO inventa un plazo', () => {
    expect(fechaLimiteAgencia(null)).toBeNull();
    expect(fechaLimiteAgencia('')).toBeNull();
    expect(fechaLimiteAgencia('no-es-una-fecha')).toBeNull();
  });
});

describe('mensajeSeguimiento — en agencia (la plata)', () => {
  it('dice dónde está, hasta cuándo, con qué reclamarlo y cuánto paga', () => {
    const m = mensajeSeguimiento(base);
    expect(m).toContain('Maria');
    expect(m).toContain('Reloj Smart X9');
    expect(m).toContain('LAARCOURIER');
    expect(m).toContain('Guayaquil');
    expect(m).toContain('9988776');
    expect(m).toContain('$45.00');
    expect(m).toContain('cédula');
    expect(m).toMatch(/devuelven/i);
    expect(m).toContain('https://rastreo.example/9988776');
  });

  it('sin last_movement_at avisa igual, pero sin fecha inventada', () => {
    const m = mensajeSeguimiento({ ...base, lastMovementAt: null });
    expect(m).toMatch(/devuelven/i);
    expect(m).toMatch(/pronto/i);
    expect(m).not.toMatch(/antes del/);
  });
});

describe('mensajeSeguimiento — nunca deja huecos', () => {
  const FASES: SegStatusKey[] = [
    'procesamiento', 'guia', 'bodega_trans', 'transito', 'reparto',
    'novedad', 'novedad_sol', 'oficina', 'rechazado',
    'devolucion_transito', 'devolucion', 'indemnizada', 'entregado',
    'cancelado', 'otros',
  ];

  // ── GUARDIÁN ────────────────────────────────────────────────────────
  // Este es el fallo que un template de string produce solo: mandarle al
  // cliente "Guía: undefined" o "la oficina de  en ". El mensaje va a una
  // persona real por WhatsApp; un hueco quema la confianza de la venta.
  it('con TODOS los campos vacíos, ninguna fase produce basura', () => {
    for (const fase of FASES) {
      const m = mensajeSeguimiento({ nombre: '', producto: '', fase });
      expect(m.length, `fase ${fase} devolvió vacío`).toBeGreaterThan(10);
      expect(m, `fase ${fase}`).not.toMatch(/undefined|null|NaN/);
      // Sin dobles espacios ni puntuación colgada por un dato ausente.
      expect(m, `fase ${fase}`).not.toMatch(/ {2}/);
      expect(m, `fase ${fase}`).not.toMatch(/:\s*$/m);
      expect(m, `fase ${fase}`).not.toMatch(/\(\)/);
    }
  });

  it('con TODOS los campos llenos, ninguna fase produce basura', () => {
    for (const fase of FASES) {
      const m = mensajeSeguimiento({ ...base, fase });
      expect(m, `fase ${fase}`).not.toMatch(/undefined|null|NaN/);
      expect(m, `fase ${fase}`).not.toMatch(/ {2}/);
    }
  });

  it('sin transportadora dice "la transportadora", no un hueco', () => {
    const m = mensajeSeguimiento({ ...base, transportadora: '' });
    expect(m).toContain('la transportadora');
    expect(m).not.toMatch(/oficina de\s+en/);
  });

  it('sin guía no escribe la línea de guía', () => {
    const m = mensajeSeguimiento({ ...base, fase: 'transito', guia: '' });
    expect(m).not.toMatch(/Guía:/);
  });

  it('sin trackingUrl no ofrece rastreo', () => {
    const m = mensajeSeguimiento({ ...base, trackingUrl: null });
    expect(m).not.toMatch(/seguirlo acá/);
  });
});

describe('mensajeSeguimiento — cada fase dice lo suyo', () => {
  it('reparto pide el efectivo listo', () => {
    const m = mensajeSeguimiento({ ...base, fase: 'reparto' });
    expect(m).toMatch(/efectivo/i);
    expect(m).toContain('$45.00');
  });

  it('novedad cita lo que dijo la transportadora y pide la dirección', () => {
    const m = mensajeSeguimiento({ ...base, fase: 'novedad', novedad: 'DIRECCION ERRADA' });
    expect(m).toContain('DIRECCION ERRADA');
    expect(m).toMatch(/direcci[óo]n completa/i);
  });

  it('devolución es un rescate, no un aviso de cierre', () => {
    const m = mensajeSeguimiento({ ...base, fase: 'devolucion' });
    expect(m).toMatch(/otra vez|de nuevo/i);
  });

  it('entregado/cancelado caen al genérico sin prometer nada', () => {
    for (const fase of ['entregado', 'cancelado', 'indemnizada'] as SegStatusKey[]) {
      const m = mensajeSeguimiento({ ...base, fase });
      expect(m).toMatch(/Te escribo por/);
      expect(m, `fase ${fase} no debe prometer entrega`).not.toMatch(/en camino|en ruta|te está esperando/i);
    }
  });
});

describe('urlWhatsApp', () => {
  it('arma wa.me con el texto codificado', () => {
    const u = urlWhatsApp('593987654321', 'Hola Maria');
    expect(u).toBe('https://wa.me/593987654321?text=Hola%20Maria');
  });

  it('limpia el + y los espacios del teléfono', () => {
    expect(urlWhatsApp('+57 300 123 4567', 'x')).toContain('wa.me/573001234567');
  });

  it('sin teléfono usable devuelve null (wa.me sin número es una pantalla de error)', () => {
    expect(urlWhatsApp('', 'hola')).toBeNull();
    expect(urlWhatsApp(null, 'hola')).toBeNull();
    expect(urlWhatsApp('12345', 'hola')).toBeNull();
  });

  it('sin texto abre el chat igual (no pierde el contacto)', () => {
    expect(urlWhatsApp('573001234567', '')).toBe('https://wa.me/573001234567');
  });

  it('los saltos de línea del mensaje sobreviven a la codificación', () => {
    const u = urlWhatsApp('573001234567', 'linea1\n\nlinea2');
    expect(u).toContain('%0A%0A');
  });
});
