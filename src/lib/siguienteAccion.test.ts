import { describe, it, expect } from 'vitest';
import { siguienteAccion, hayTrabajo, type SiguienteAccionInput } from './siguienteAccion';
import { esAccionable } from './segLists';
import type { OrderData } from './orderUtils';

/**
 * Mismo criterio determinista que segLists.test.ts: `fecha: ''` + `dias: N`
 * fuerza el fallback a `o.dias` y evita el jitter de días hábiles/feriados.
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

const hace = (horas: number) => new Date(Date.now() - horas * 3600 * 1000).toISOString();

// Pedidos que caen en cada escalón. Se construyen con los mismos estados que
// usa segLists.test.ts para que un cambio de matcher rompa acá también.
const enAgencia   = { ...base, estado: 'RECLAMAR EN OFICINA', lastMovementAt: hace(60) };
const detenido    = { ...base, estado: 'EN TRANSITO', lastMovementAt: hace(100) };
const devuelto    = { ...base, estado: 'DEVOLUCION', lastMovementAt: hace(24) };
const enReparto   = { ...base, estado: 'EN REPARTO', dias: 1, lastMovementAt: hace(2) };
const porConfirm  = { ...base, estado: 'PENDIENTE CONFIRMACION' };
const enTransito  = { ...base, estado: 'EN TRANSITO', lastMovementAt: hace(2) };

const vacio: SiguienteAccionInput = { workQueue: [], novedadesQueue: [], segData: [] };

describe('siguienteAccion — el orden de la escalera', () => {
  it('sin nada pendiente devuelve al_dia', () => {
    const r = siguienteAccion(vacio);
    expect(r.key).toBe('al_dia');
    expect(r.cuantos).toBe(0);
    expect(r.tono).toBe('listo');
  });

  it('novedades gana sobre TODO lo demás', () => {
    const r = siguienteAccion({
      workQueue: [porConfirm, porConfirm],
      novedadesQueue: [base],
      segData: [enAgencia, detenido, devuelto],
    });
    expect(r.key).toBe('novedades');
    expect(r.cuantos).toBe(1);
    expect(r.ruta).toBe('/novedades');
  });

  it('agencia gana sobre confirmar — el paquete ya llegó y tiene reloj', () => {
    const r = siguienteAccion({
      workQueue: [porConfirm, porConfirm, porConfirm],
      novedadesQueue: [],
      segData: [enAgencia],
    });
    expect(r.key).toBe('agencia');
    expect(r.ruta).toContain('agencia_2d');
  });

  it('confirmar gana sobre detenidos y rescate', () => {
    const r = siguienteAccion({
      workQueue: [porConfirm],
      novedadesQueue: [],
      segData: [detenido, devuelto],
    });
    expect(r.key).toBe('confirmar');
    expect(r.cuantos).toBe(1);
    expect(r.ruta).toBe('/confirmar');
  });

  it('detenidos gana sobre rescate', () => {
    const r = siguienteAccion({ workQueue: [], novedadesQueue: [], segData: [detenido, devuelto] });
    expect(r.key).toBe('detenidos');
  });

  it('rescate es el último escalón nombrado', () => {
    const r = siguienteAccion({ workQueue: [], novedadesQueue: [], segData: [devuelto] });
    expect(r.key).toBe('rescate');
    expect(r.ruta).toContain('devolucion_reciente');
  });

  it('lo que solo se vigila NO genera acción', () => {
    // Un pedido viajando bien no es trabajo: mirarlo no cambia nada.
    const r = siguienteAccion({ workQueue: [], novedadesQueue: [], segData: [enTransito] });
    expect(r.key).toBe('al_dia');
  });
});

describe('siguienteAccion — el conteo', () => {
  it('en Confirmar cuenta solo los que NO tienen result', () => {
    const r = siguienteAccion({
      workQueue: [porConfirm, { ...porConfirm, result: 'conf' }, { ...porConfirm, result: 'canc' }, porConfirm],
      novedadesQueue: [],
      segData: [],
    });
    expect(r.key).toBe('confirmar');
    expect(r.cuantos).toBe(2);
  });

  it('un workQueue enteramente gestionado no genera acción de confirmar', () => {
    const r = siguienteAccion({
      workQueue: [{ ...porConfirm, result: 'conf' }],
      novedadesQueue: [],
      segData: [],
    });
    expect(r.key).toBe('al_dia');
  });

  it('el texto cambia entre singular y plural', () => {
    const uno = siguienteAccion({ workQueue: [], novedadesQueue: [base], segData: [] });
    const dos = siguienteAccion({ workQueue: [], novedadesQueue: [base, base], segData: [] });
    expect(uno.titulo).not.toMatch(/\b1\b/);
    expect(dos.titulo).toContain('2');
  });

  it('ninguna acción sale con cuantos en 0 salvo al_dia', () => {
    const casos: SiguienteAccionInput[] = [
      { workQueue: [], novedadesQueue: [base], segData: [] },
      { workQueue: [], novedadesQueue: [], segData: [enAgencia] },
      { workQueue: [porConfirm], novedadesQueue: [], segData: [] },
      { workQueue: [], novedadesQueue: [], segData: [detenido] },
      { workQueue: [], novedadesQueue: [], segData: [devuelto] },
      { workQueue: [], novedadesQueue: [], segData: [enReparto] },
    ];
    for (const c of casos) {
      const r = siguienteAccion(c);
      expect(r.key, JSON.stringify(r)).not.toBe('al_dia');
      expect(r.cuantos, JSON.stringify(r)).toBeGreaterThan(0);
      expect(r.titulo.length).toBeGreaterThan(5);
      expect(r.porque.length).toBeGreaterThan(5);
      expect(r.ruta.startsWith('/')).toBe(true);
      // La etiqueta neutra (la que ve el dueño) SIEMPRE nombra la cantidad y
      // NUNCA da una orden: darle una instrucción a quien no ejecuta es ruido.
      expect(r.etiqueta, JSON.stringify(r)).toContain(String(r.cuantos));
      expect(r.etiqueta).not.toMatch(/á|Confirmá|Resolvé|Gestioná|Avisá|Reclamá|Intentá/);
    }
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// El peor resultado posible de esta pantalla: que a la asesora la regañen por
// estar quieta mientras la barra le dice "Todo al día". Ahí la herramienta se
// contradice a sí misma y pierde toda autoridad.
//
// La regla es una IMPLICACIÓN, no una equivalencia:
//     el guard ve trabajo  ⟹  la barra NO dice "al día"
// El sentido contrario está permitido a propósito (la barra puede ofrecer el
// rescate de devoluciones, que el guard no exige) — esa divergencia va en la
// dirección segura.
//
// Esto vigila sobre todo el escalón 6 (catch-all de Seguimiento): sin él, una
// lista accionable sin escalón propio —indemnizaciones vencidas, pendientes de
// guía, reparto/novedad— dejaba la barra en verde con el guard regañando. Si
// alguien lo borra "porque no se usa", esta prueba cae.
describe('GUARDIÁN: la barra nunca dice "al día" con el guard regañando', () => {
  it('si el guard ve trabajo, la barra SIEMPRE ofrece un escalón', () => {
    const universo = [enAgencia, detenido, devuelto, enReparto, enTransito];
    let casosConTrabajo = 0;

    // Todos los subconjuntos de segData, cruzados con Confirmar y Novedades.
    for (let mask = 0; mask < (1 << universo.length); mask++) {
      const segData = universo.filter((_, i) => mask & (1 << i));
      for (const workQueue of [[], [porConfirm]]) {
        for (const novedadesQueue of [[], [base]]) {
          const input = { workQueue, novedadesQueue, segData };

          // La definición del guard de inactividad, replicada tal cual
          // (InactivityGuard.tsx): pendientes de Confirmar, o novedades
          // abiertas, o alguna lista accionable de Seguimiento.
          const guardVeTrabajo =
            workQueue.some((o) => !o.result) ||
            novedadesQueue.length > 0 ||
            segData.some(esAccionable);

          const r = siguienteAccion(input);
          if (guardVeTrabajo) {
            casosConTrabajo++;
            expect(r.key, JSON.stringify({ mask, key: r.key })).not.toBe('al_dia');
            expect(hayTrabajo(input)).toBe(true);
          }
        }
      }
    }

    // Que el barrido haya ejercitado el caso interesante y no solo el vacío.
    expect(casosConTrabajo).toBeGreaterThan(50);
  });

  it('sin NADA en ninguna cola, sí dice al_dia', () => {
    expect(siguienteAccion(vacio).key).toBe('al_dia');
    expect(hayTrabajo(vacio)).toBe(false);
  });

  it('devolucion_reciente NO es accionable, pero SÍ tiene escalón propio', () => {
    // Es la excepción deliberada: la llamada de rescate se hace una vez, no se
    // exige a diario, así que no entra al guard de inactividad. Pero si es lo
    // único que queda, la barra debe ofrecerlo igual en vez de decir "al día".
    expect(esAccionable(devuelto)).toBe(false);
    const r = siguienteAccion({ workQueue: [], novedadesQueue: [], segData: [devuelto] });
    expect(r.key).toBe('rescate');
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// Un cero que en realidad es "todavía no leí" es una MENTIRA en verde.
//
// Esto no es hipotético: se midió el 21-ago-2026 en el Dashboard de Colombia.
// `segData` solo lo cargaba `SeguimientoTab`, y esta barra se esconde en
// `/seguimiento` — así que en toda pantalla donde la barra SE VE, la cola de
// Seguimiento llegaba vacía. La barra decía "Todo al día" con 7 pedidos
// detenidos y 5 paquetes esperando en una agencia.
//
// Misma regla que `turnoDelEquipo`: cero NUNCA sustituye a "no se pudo medir".
describe('GUARDIÁN: sin la cola cargada, la barra no afirma "al día"', () => {
  it('segCargado:false nunca devuelve al_dia, ni con segData vacío', () => {
    expect(siguienteAccion({ ...vacio, segCargado: false }).key).toBe('cargando');
    expect(hayTrabajo({ ...vacio, segCargado: false })).toBe(false);
  });

  it('lo que SÍ está cargado sigue mandando: novedades y confirmar', () => {
    // Estas dos colas no dependen de segData — se cargan globalmente. Callarlas
    // mientras Seguimiento llega sería el error opuesto.
    expect(siguienteAccion({ ...vacio, novedadesQueue: [base], segCargado: false }).key).toBe('novedades');
    expect(siguienteAccion({ ...vacio, workQueue: [porConfirm], segCargado: false }).key).toBe('confirmar');
  });

  it('con la cola cargada y trabajo de Seguimiento, la barra lo dice', () => {
    // El caso que estaba roto en producción: agencia y detenidos invisibles.
    expect(siguienteAccion({ ...vacio, segData: [enAgencia], segCargado: true }).key).toBe('agencia');
    expect(siguienteAccion({ ...vacio, segData: [detenido], segCargado: true }).key).toBe('detenidos');
  });

  it('el default es "cargado": los call-sites viejos no cambian de conducta', () => {
    expect(siguienteAccion({ ...vacio, segData: [enAgencia] }).key).toBe('agencia');
    expect(siguienteAccion(vacio).key).toBe('al_dia');
  });
});

describe('el escalón de la agencia escala con el reloj', () => {
  // El protocolo del dueño ("Día 2: aviso. Día 5: llamada") estaba escrito en la
  // pantalla y no existía en el código. Ahora el escalón cambia de mensaje.
  const enAgenciaUrgente = { ...base, estado: 'RECLAMAR EN OFICINA', lastMovementAt: hace(140) };
  const input = (segData: OrderData[]): SiguienteAccionInput => ({
    workQueue: [], segData, segCargado: true, novedadesQueue: [],
  });

  it('a los 2 días dice AVISAR', () => {
    const a = siguienteAccion(input([enAgencia]));
    expect(a.key).toBe('agencia');
    expect(a.titulo).toMatch(/Avisá/);
  });

  it('a los 5 días dice LLAMAR y avisa que se devuelve', () => {
    const a = siguienteAccion(input([enAgenciaUrgente]));
    expect(a.key).toBe('agencia');
    expect(a.titulo).toMatch(/Llamá/);
    expect(a.titulo).toMatch(/dos días/);
    expect(a.ruta).toContain('agencia_5d');
  });

  it('el de 5 días manda sobre el de 2 aunque sean menos', () => {
    // Tres por avisar y uno por llamar: gana el que se pierde esta semana.
    const a = siguienteAccion(input([enAgencia, enAgencia, enAgencia, enAgenciaUrgente]));
    expect(a.cuantos).toBe(1);
    expect(a.titulo).toMatch(/Llamá/);
  });

  it('un paquete de 6 días en agencia sigue contando como trabajo', () => {
    // Si al partir la lista el tramo nuevo no fuera accionable, el paquete más
    // urgente desaparecería de la cola justo al cruzar las 120 h.
    expect(esAccionable(enAgenciaUrgente)).toBe(true);
    expect(hayTrabajo(input([enAgenciaUrgente]))).toBe(true);
  });
});

describe('el escalon de aviso no pide trabajo ya hecho', () => {
  // `enAgencia` lleva 60 h en la agencia (tramo de 2 dias, todavia no 5).
  const llegada = Date.now() - 60 * 3600 * 1000;
  const pedido = (phone: string) => ({ ...enAgencia, phone });

  it('sin el mapa de avisos cuenta todos, como antes', () => {
    const r = siguienteAccion({ ...vacio, segData: [pedido('A'), pedido('B')] });
    expect(r.key).toBe('agencia');
    expect(r.cuantos).toBe(2);
  });

  it('con el mapa, solo cuenta a los que todavia no saben', () => {
    // Una barra que pide avisar a 20 cuando a 18 ya se les aviso ensena a
    // ignorarla, y asi es como muere una barra de prioridad.
    const avisosAgencia = new Map([['A', llegada + 3600 * 1000]]);
    const r = siguienteAccion({ ...vacio, segData: [pedido('A'), pedido('B')], avisosAgencia });
    expect(r.key).toBe('agencia');
    expect(r.cuantos).toBe(1);
    expect(r.titulo).toContain('Avisá');
  });

  it('un aviso ANTERIOR a la llegada no cuenta: es de otro pedido del mismo cliente', () => {
    const avisosAgencia = new Map([['A', llegada - 40 * 86400000]]);
    const r = siguienteAccion({ ...vacio, segData: [pedido('A')], avisosAgencia });
    expect(r.cuantos).toBe(1);
  });

  it('si a todos se les aviso, el escalon cede el turno', () => {
    const avisosAgencia = new Map([['A', llegada + 1000], ['B', llegada + 1000]]);
    const r = siguienteAccion({
      ...vacio,
      segData: [pedido('A'), pedido('B')],
      workQueue: [porConfirm],
      avisosAgencia,
    });
    expect(r.key).toBe('confirmar');
  });

  it('el tramo de 5 dias NO se filtra por aviso: ahi lo que toca es llamar', () => {
    const urgente = { ...base, estado: 'RECLAMAR EN OFICINA', phone: 'A', lastMovementAt: hace(130) };
    const avisosAgencia = new Map([['A', Date.now()]]);
    const r = siguienteAccion({ ...vacio, segData: [urgente], avisosAgencia });
    expect(r.key).toBe('agencia');
    expect(r.cuantos).toBe(1);
    expect(r.titulo).toContain('Llamá');
  });

  it('sin reloj de llegada el pedido no entra en agencia_2d y no se inventa aviso', () => {
    const sinReloj = { ...base, estado: 'RECLAMAR EN OFICINA', phone: 'A', lastMovementAt: null };
    const r = siguienteAccion({ ...vacio, segData: [sinReloj], avisosAgencia: new Map() });
    expect(r.key).not.toBe('agencia');
  });
});
