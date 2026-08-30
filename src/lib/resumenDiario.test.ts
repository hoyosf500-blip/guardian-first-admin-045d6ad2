import { describe, it, expect } from 'vitest';
import {
  construirResumen,
  titularDe,
  type DatosResumen,
} from '../../supabase/functions/_shared/resumenDiario';

/**
 * El test vive en `src/lib/` y cruza el límite a `supabase/functions/_shared/`
 * a propósito: `vitest.config.ts` solo incluye `src/**`, así que un test puesto
 * al lado de la edge function NO se ejecutaría nunca —ni acá ni en CI—. Es el
 * mismo patrón de `autoPushSelect.test.ts` y `walletCategoria.test.ts`.
 */

const base: DatosResumen = {
  tienda: 'Rushmira (Colombia)',
  dia: 'viernes, 21 de agosto',
  cierres: [],
  asesorasDelTurno: 0,
  novedadesAbiertas: 0,
  entregadosHoy: 0,
  canceladosHoy: 0,
  sinFechaDeMovimiento: 0,
  minutosDesdeSync: 8,
};

const cierre = (nombre: string, cola: number, gestionados: number, motivo: string | null = null) => ({
  nombre, cola, gestionados, faltaron: Math.max(cola - gestionados, 0), motivo,
});

describe('titularDe — una frase con lo que importa', () => {
  it('lo que quedó sin gestionar manda sobre todo lo demás', () => {
    // Es lo único que todavía se puede salvar; el resto del día ya pasó.
    const d = { ...base, asesorasDelTurno: 2, novedadesAbiertas: 9, cierres: [cierre('Ana', 20, 14, 'x')] };
    expect(titularDe(d)).toMatch(/quedaron 6 pedidos sin gestionar/i);
  });

  it('cero cierres con equipo en turno es su propio titular', () => {
    const d = { ...base, asesorasDelTurno: 2 };
    expect(titularDe(d)).toMatch(/nadie cerró el día/i);
  });

  it('cerrado en cero pero alguien no firmó: lo dice', () => {
    const d = { ...base, asesorasDelTurno: 3, cierres: [cierre('Ana', 10, 10)] };
    expect(titularDe(d)).toMatch(/2 personas no cerraron/i);
  });

  it('todo cerrado en cero y sin novedades: el titular es bueno y corto', () => {
    const d = { ...base, asesorasDelTurno: 1, cierres: [cierre('Ana', 10, 10)] };
    expect(titularDe(d)).toBe('Seguimiento cerró en cero.');
  });

  it('singular y plural bien escritos', () => {
    const uno = { ...base, asesorasDelTurno: 1, cierres: [cierre('Ana', 5, 4, 'motivo largo de verdad')] };
    expect(titularDe(uno)).toMatch(/1 pedido sin gestionar\./);
  });
});

describe('construirResumen — las dos mitades no se mezclan', () => {
  it('lo declarado por el equipo va con su motivo textual', () => {
    const d = {
      ...base,
      asesorasDelTurno: 2,
      cierres: [
        cierre('Ana', 20, 14, 'La transportadora no contesta desde ayer'),
        cierre('Bea', 12, 12),
      ],
    };
    const r = construirResumen(d);
    expect(r.texto).toContain('Ana: faltaron 6 de 20');
    expect(r.texto).toContain('«La transportadora no contesta desde ayer»');
    expect(r.texto).toContain('Bea: en cero (12 de 12)');
  });

  it('los números medidos van en su propia sección', () => {
    const r = construirResumen({ ...base, entregadosHoy: 31, canceladosHoy: 4, novedadesAbiertas: 7 });
    expect(r.texto).toContain('Entregados hoy: 31');
    expect(r.texto).toContain('Cancelados hoy: 4');
    expect(r.texto).toContain('Novedades abiertas ahora: 7');
  });

  it('el asunto lleva la tienda y el titular', () => {
    const r = construirResumen({ ...base, asesorasDelTurno: 2 });
    expect(r.asunto).toContain('Rushmira (Colombia)');
    expect(r.asunto).toContain('Nadie cerró el día');
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// Este correo se lee de reojo desde el teléfono. Un resumen que se calla se
// lee como un día tranquilo, y ahí el aviso hace exactamente lo contrario de
// lo que vino a hacer: da tranquilidad falsa.
describe('GUARDIÁN: el silencio no se lee como "todo bien"', () => {
  it('sin cierres, el correo DICE que no se sabe cómo terminó', () => {
    const r = construirResumen({ ...base, asesorasDelTurno: 2 });
    expect(r.texto).toMatch(/nadie firmó el cierre/i);
    expect(r.texto).toMatch(/no se sabe cómo terminó/i);
  });

  it('sin dato de sincronización lo dice, no imprime "hace 0 min"', () => {
    const r = construirResumen({ ...base, minutosDesdeSync: null });
    expect(r.texto).toMatch(/sin dato/i);
    expect(r.texto).not.toMatch(/hace 0 min/);
  });

  it('los pedidos invisibles se nombran y se explica qué hacer', () => {
    const r = construirResumen({ ...base, sinFechaDeMovimiento: 40 });
    expect(r.texto).toContain('Sin fecha de movimiento: 40');
    expect(r.texto).toMatch(/no aparecen en ninguna alarma/i);
  });

  it('cuando no hay ninguno, no se menciona (cero no es una alarma)', () => {
    const r = construirResumen({ ...base, sinFechaDeMovimiento: 0 });
    expect(r.texto).not.toMatch(/sin fecha de movimiento/i);
  });

  it('una tienda sin equipo no se reporta como "nadie cerró"', () => {
    // Sin gente asignada no hay a quién reclamarle: acusar ahí sería ruido.
    const r = construirResumen({ ...base, asesorasDelTurno: 0 });
    expect(r.texto).toMatch(/sin equipo asignado/i);
    expect(titularDe({ ...base, asesorasDelTurno: 0 })).not.toMatch(/nadie cerró/i);
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// Este error se cometió acá mismo, el día que se escribió el archivo: la
// consulta filtraba por `orders.updated_at`, una columna que NO EXISTE.
// PostgREST devolvía error, el conteo llegaba en null y un `?? 0` lo imprimía
// como "Entregados hoy: 0". El dueño habría leído un viernes sin una sola
// entrega —con 88 pedidos en ruta— y no habría tenido forma de sospecharlo.
describe('GUARDIÁN: un conteo que falló NO se imprime como cero', () => {
  it('entregados/cancelados en null dicen "sin dato"', () => {
    const r = construirResumen({ ...base, entregadosHoy: null, canceladosHoy: null });
    expect(r.texto).toContain('Entregados hoy: sin dato');
    expect(r.texto).toContain('Cancelados hoy: sin dato');
    expect(r.texto).not.toContain('Entregados hoy: 0');
  });

  it('un cero REAL sí se imprime como cero', () => {
    // Un día sin entregas existe. Lo que no puede pasar es confundirlo con un
    // día que nadie contó.
    const r = construirResumen({ ...base, entregadosHoy: 0, canceladosHoy: 0 });
    expect(r.texto).toContain('Entregados hoy: 0');
  });
});

/**
 * ⛔ GUARDIÁN — los CUATRO conteos del correo dicen "sin dato", no 0.
 *
 * El arreglo de "null en vez de 0" se había aplicado solo a `entregadosHoy` y
 * `canceladosHoy`. Los otros dos del MISMO Promise.all quedaron con `?? 0`, así
 * que el correo de las 21:00 podía decirle al dueño «Novedades abiertas: 0»
 * sobre un día que nunca se pudo medir. A diferencia de un 0 en entregados —que
 * al menos alarma— un 0 en novedades abiertas se lee como BUENA NOTICIA, y el
 * dueño no revisa la cola.
 */
describe('⛔ resumen-diario: los cuatro conteos, no dos', () => {
  // Con la cola CERRADA en cero (todos gestionaron todo): así el titular llega
  // hasta la rama de novedades en vez de cortar antes con "nadie cerró".
  const base: DatosResumen = {
    tienda: 'Rushmira EC',
    dia: 'viernes, 30 de agosto',
    cierres: [cierre('Ana', 10, 10), cierre('Luis', 8, 8)],
    asesorasDelTurno: 2,
    novedadesAbiertas: null,
    entregadosHoy: null,
    canceladosHoy: null,
    sinFechaDeMovimiento: null,
    minutosDesdeSync: 12,
  };

  it('«Novedades abiertas» sin dato NO se imprime como 0', () => {
    const r = construirResumen(base);
    expect(r.texto).toContain('Novedades abiertas ahora: sin dato');
    expect(r.texto).not.toContain('Novedades abiertas ahora: 0');
  });

  it('«Sin fecha de movimiento» sin dato no inventa una línea tranquilizadora', () => {
    const r = construirResumen(base);
    expect(r.texto).not.toContain('Sin fecha de movimiento: 0');
  });

  it('el TITULAR no puede decir "cerró en cero" a secas si no se contaron las novedades', () => {
    const r = construirResumen(base);
    expect(r.titular).toMatch(/no se pudo contar/i);
  });

  it('con los datos medidos sigue diciendo lo de siempre', () => {
    const r = construirResumen({ ...base, novedadesAbiertas: 0, entregadosHoy: 5, canceladosHoy: 1, sinFechaDeMovimiento: 0 });
    expect(r.texto).toContain('Novedades abiertas ahora: 0');
    expect(r.titular).toBe('Seguimiento cerró en cero.');
  });

  it('y con novedades abiertas de verdad, las nombra', () => {
    const r = construirResumen({ ...base, novedadesAbiertas: 3, entregadosHoy: 5, canceladosHoy: 1, sinFechaDeMovimiento: 0 });
    expect(r.titular).toContain('3 novedades abiertas');
  });
});
