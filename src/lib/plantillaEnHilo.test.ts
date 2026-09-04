import { describe, it, expect } from 'vitest';
import { anclaDePlantilla, idsSalientes, plantillaAparecio, normalizarParaBuscar, ANCLA_MIN, type MensajeCrudo } from './plantillaEnHilo';
import { PLANTILLAS_EC } from './plantillasCuentaEC.fixture';
import { PLANTILLAS_CO } from './plantillasCuentaCO.fixture';

const CUERPO = 'Hola {{1}}, tu pedido ya llegó y está listo para que lo retires 🎉\n\n📍Agencia: {{2}}';
const ANCLA = anclaDePlantilla(CUERPO)!;

const sal = (id: string, texto: string, tipo = 'text'): MensajeCrudo => ({
  id, rol_mensaje: 1, texto_mensaje: texto, tipo_mensaje: tipo,
});
const ent = (id: string, texto: string): MensajeCrudo => ({ id, rol_mensaje: 0, texto_mensaje: texto });

describe('anclaDePlantilla', () => {
  it('saca el tramo más largo ENTRE huecos, sin depender de los valores', () => {
    expect(ANCLA).toBe('tu pedido ya llego y esta listo para que lo retires agencia');
  });

  it('una plantilla que es puro hueco no tiene ancla', () => {
    expect(anclaDePlantilla('{{1}} {{2}}')).toBeNull();
    expect(anclaDePlantilla('Hola {{1}}')).toBeNull(); // "hola" es demasiado corto
  });

  it('normaliza tildes, emoji y puntuación', () => {
    expect(normalizarParaBuscar('¡Hola, Néstor! 🎉  Su pedido…')).toBe('hola nestor su pedido');
  });
});

describe('plantillaAparecio — la señal', () => {
  const antes = idsSalientes([sal('1', 'mensaje viejo del bot')]);

  it('confirma con el mensaje RENDERIZADO (valores distintos al ejemplo)', () => {
    const r = plantillaAparecio(antes, [
      sal('1', 'mensaje viejo del bot'),
      sal('2', 'Hola Néstor, tu pedido ya llegó y está listo para que lo retires 🎉\n\n📍Agencia: SERVIENTREGA'),
    ], { ancla: ANCLA, nombre: 'retiro_agencia_k1' });
    expect(r.visto).toBe(true);
    expect(r.senal).toBe('ancla');
    expect(r.mensajeId).toBe('2');
  });

  it('confirma con el cuerpo CRUDO (los {{1}} sin rellenar) — el ancla no depende de los valores', () => {
    const r = plantillaAparecio(antes, [sal('1', 'mensaje viejo del bot'), sal('2', CUERPO)],
      { ancla: ANCLA, nombre: 'retiro_agencia_k1' });
    expect(r.visto).toBe(true);
    expect(r.senal).toBe('ancla');
  });

  it('⛔ un mensaje idéntico que YA ESTABA no confirma (es el bug que se está arreglando)', () => {
    const hilo = [sal('1', 'Hola Ana, tu pedido ya llegó y está listo para que lo retires 🎉')];
    const r = plantillaAparecio(idsSalientes(hilo), hilo, { ancla: ANCLA, nombre: 'retiro_agencia_k1' });
    expect(r.visto, 'confirmar sobre un mensaje viejo es exactamente la mentira que hay que matar').toBe(false);
    expect(r.motivo).toBe('sin_novedad');
  });

  it('un saliente nuevo del bot con OTRO cuerpo no confirma', () => {
    const r = plantillaAparecio(antes, [sal('1', 'mensaje viejo del bot'), sal('2', 'Buenas! ¿En qué le puedo ayudar?')],
      { ancla: ANCLA, nombre: 'retiro_agencia_k1' });
    expect(r.visto).toBe(false);
    expect(r.motivo).toBe('sin_novedad');
  });

  it('un mensaje ENTRANTE nuevo no confirma nada', () => {
    const r = plantillaAparecio(antes, [sal('1', 'mensaje viejo del bot'), ent('9', CUERPO)],
      { ancla: ANCLA, nombre: 'retiro_agencia_k1' });
    expect(r.visto).toBe(false);
  });

  it('un marcador sin texto pero de tipo template sí confirma', () => {
    const r = plantillaAparecio(antes, [sal('1', 'mensaje viejo del bot'), sal('2', '', 'template')],
      { ancla: ANCLA, nombre: 'retiro_agencia_k1' });
    expect(r.visto).toBe(true);
    expect(r.senal).toBe('tipo');
  });

  it('cae al nombre de la plantilla cuando el panel guarda eso', () => {
    const r = plantillaAparecio(antes, [sal('1', 'mensaje viejo del bot'), sal('2', 'retiro_agencia_k1')],
      { ancla: ANCLA, nombre: 'retiro_agencia_k1' });
    expect(r.visto).toBe(true);
    expect(r.senal).toBe('nombre');
  });
});

describe('plantillaAparecio — "no sé" NO es "no salió"', () => {
  it('sin hilo devuelve sin_hilo, no sin_novedad', () => {
    const r = plantillaAparecio(new Set(), null, { ancla: ANCLA, nombre: 'x' });
    expect(r.motivo).toBe('sin_hilo');
    expect(r.visto).toBe(false);
  });

  it('sin baseline devuelve sin_ids', () => {
    const r = plantillaAparecio(null, [sal('2', CUERPO)], { ancla: ANCLA, nombre: 'x' });
    expect(r.motivo).toBe('sin_ids');
  });

  it('un hilo cuyos salientes no traen id devuelve sin_ids', () => {
    const r = plantillaAparecio(new Set(), [{ rol_mensaje: 1, texto_mensaje: CUERPO }],
      { ancla: ANCLA, nombre: 'x' });
    expect(r.motivo).toBe('sin_ids');
  });
});

describe('las plantillas REALES de las dos cuentas tienen ancla usable', () => {
  const conCuerpo = [...PLANTILLAS_EC, ...PLANTILLAS_CO].filter((p) => (p.cuerpo ?? '').trim());

  it('hay plantillas reales que probar', () => {
    expect(conCuerpo.length).toBeGreaterThan(10);
  });

  it('todas tienen un ancla de al menos el mínimo', () => {
    const sinAncla = conCuerpo.filter((p) => {
      const a = anclaDePlantilla(p.cuerpo);
      return !a || a.length < ANCLA_MIN;
    });
    expect(sinAncla.map((p) => p.nombre), 'una plantilla sin ancla no se puede confirmar en el hilo').toEqual([]);
  });

  it('⛔ dos plantillas DISTINTAS de la misma cuenta no comparten ancla', () => {
    // Si dos plantillas que NO son versiones de un mismo mensaje comparten
    // ancla, esa ancla es demasiado genérica y podría confirmar el envío de la
    // otra. En ese caso se ALARGA la regla — nunca se baja el umbral.
    //
    // Colisionar entre VERSIONES del mismo mensaje sí se acepta: medido sobre
    // las cuentas reales son cuatro familias (en_camino_hoy v1/v2, novedad k2,
    // las cuatro confirmaciones con/sin imagen, y los tres seguimientos de
    // guía). El baseline por id ya las cubre — solo cuentan los mensajes NUEVOS —
    // y el único residuo sería que el bot mande la v1 en el mismo instante en
    // que nosotros mandamos la v2: ahí al cliente le llegó igual un mensaje casi
    // idéntico.
    const familia = (nombre: string) =>
      nombre
        .toLowerCase()
        .replace(/[^a-z]+/g, ' ')
        .split(' ')
        .filter((t) => t && !['v', 'k', 'utilidad', 'pdf', 'gt', 'con', 'sin', 'imagen'].includes(t))
        .map((t) => t.replace(/[vk]$/, ''))
        .join('');

    for (const [cuenta, lista] of [['EC', PLANTILLAS_EC], ['CO', PLANTILLAS_CO]] as const) {
      const porAncla = new Map<string, string[]>();
      for (const p of lista) {
        const a = anclaDePlantilla(p.cuerpo ?? '');
        if (!a) continue;
        porAncla.set(a, [...(porAncla.get(a) ?? []), p.nombre]);
      }
      const choques = [...porAncla.entries()]
        .filter(([, nombres]) => nombres.length > 1)
        .filter(([, nombres]) => new Set(nombres.map(familia)).size > 1)
        .map(([ancla, nombres]) => `${cuenta}: "${ancla}" -> ${nombres.join(', ')}`);
      expect(choques, 'hay un ancla que matchea plantillas de mensajes DISTINTOS').toEqual([]);
    }
  });
});
