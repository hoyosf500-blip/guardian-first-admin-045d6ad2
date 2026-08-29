import { describe, it, expect } from 'vitest';
import {
  leerHojaMensajes,
  crearLectorHoja,
  parsearSharedStrings,
  letraDeRef,
  desescapar,
  serialAFecha,
  LecturaVencida,
  COLUMNAS_USADAS,
} from '../../supabase/functions/_shared/xlsxMensajes';

/**
 * El parser del export de ImporChat, que ya mató DOS veces a `importchat-sync`
 * (SheetJS por memoria en agosto, y 82 corridas colgadas de 197 medidas el
 * 28-ago) y nunca había tenido una sola prueba. `vitest.config.ts` solo mira
 * `src/**`, así que se testea desde acá cruzando el límite — igual que
 * `autoPushSelect` y `walletCategoria`.
 */

const enc = new TextEncoder();

/** Las 18 columnas del export real, en su orden. Solo 6 se usan; el resto está
 *  acá justamente para probar que se saltean sin romper el mapeo por nombre. */
const CABECERAS = [
  'ID Mensaje', 'Emisor', 'Celular Emisor', 'ID Receptor', 'Celular Receptor',
  'Rol', 'Tipo Mensaje', 'Texto Mensaje', 'Template', 'Fecha Mensaje',
  'Estado', 'Leido', 'Etiqueta', 'Agente', 'Origen', 'Adjunto', 'Notas', 'Extra',
];

const LETRAS = 'ABCDEFGHIJKLMNOPQR'.split('');

function fila(n: number, valores: (string | number | null)[]): string {
  const celdas = valores.map((v, i) => {
    if (v === null) return '';
    const ref = `${LETRAS[i]}${n}`;
    return typeof v === 'number'
      ? `<c r="${ref}"><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  }).join('');
  return `<row r="${n}">${celdas}</row>`;
}

/** Una fila de mensaje con las 18 columnas, llenando solo lo que importa. */
function mensaje(n: number, o: {
  chat: string; rol: string; tipo: string; texto?: string;
  template?: string; serial: number; ruido?: string;
}): string {
  const v: (string | number | null)[] = new Array(18).fill(null);
  v[0] = `msg-${n}`;
  v[1] = 'ImporSuit';               // Emisor: SIEMPRE el negocio, incluso si escribió el cliente
  v[3] = o.chat;                    // ID Receptor ← el cliente de verdad
  v[5] = o.rol;
  v[6] = o.tipo;
  v[7] = o.texto ?? '';
  v[8] = o.template ?? '';
  v[9] = o.serial;
  v[12] = o.ruido ?? 'ETIQUETA QUE NADIE LEE';
  return fila(n, v);
}

function hoja(filas: string[]): Uint8Array {
  return enc.encode(
    `<?xml version="1.0"?><worksheet><sheetData>${fila(1, CABECERAS)}${filas.join('')}</sheetData></worksheet>`,
  );
}

// 2026-08-24 20:50 UTC (= 15:50 local EC), el serial contrastado en vivo contra
// el created_at del mismo mensaje. Ver el comentario de serialAFecha.
const SERIAL_REF = 46258.8687;

describe('leerHojaMensajes — lo que el export de ImporChat de verdad trae', () => {
  it('agrupa por ID RECEPTOR, no por emisor', () => {
    // ⛔ La trampa ya pagada: en las filas con Rol='Cliente' el "Emisor" SIGUE
    // siendo la conexión del negocio. Cruzar por Emisor da CERO coincidencias
    // y la señal sale vacía sin ningún error visible.
    const { porChat, filas } = leerHojaMensajes(hoja([
      mensaje(2, { chat: '593999111', rol: 'Cliente', tipo: 'text', serial: SERIAL_REF }),
      mensaje(3, { chat: '593999222', rol: 'Propietario', tipo: 'template', template: 'confirmacion_pedido_k1', serial: SERIAL_REF }),
    ]), []);
    expect(filas).toBe(2);
    expect([...porChat.keys()].sort()).toEqual(['593999111', '593999222']);
    expect(porChat.get('593999111')![0].rol).toBe('Cliente');
  });

  it('lee las 6 columnas que importan de una fila de 18', () => {
    const { porChat } = leerHojaMensajes(hoja([
      mensaje(2, { chat: 'c1', rol: 'Cliente', tipo: 'button', texto: 'CONFIRMAR PEDIDO', serial: SERIAL_REF }),
    ]), []);
    const m = porChat.get('c1')![0];
    expect(m).toMatchObject({ rol: 'Cliente', tipo: 'button', texto: 'CONFIRMAR PEDIDO' });
    expect(m.fecha.toISOString()).toBe('2026-08-24T20:50:55.680Z');
  });

  it('solo los BOTONES guardan texto — el resto va vacío a propósito', () => {
    // Guardar 48.000 mensajes completos en memoria es justamente lo que mataba
    // a la función. De un mensaje normal no se lee el texto NUNCA.
    const { porChat } = leerHojaMensajes(hoja([
      mensaje(2, { chat: 'c1', rol: 'Cliente', tipo: 'text', texto: 'hola quiero saber del pedido', serial: SERIAL_REF }),
    ]), []);
    expect(porChat.get('c1')![0].texto).toBe('');
  });

  it('mapea por NOMBRE de columna: si ImporChat mete una columna al medio, sigue', () => {
    const movidas = [...CABECERAS];
    movidas.splice(2, 0, 'Columna Nueva De ImporChat');
    const letras = 'ABCDEFGHIJKLMNOPQRS'.split('');
    const celdas = (n: number, vals: (string | number | null)[]) =>
      `<row r="${n}">${vals.map((v, i) => v === null ? '' : (typeof v === 'number'
        ? `<c r="${letras[i]}${n}"><v>${v}</v></c>`
        : `<c r="${letras[i]}${n}" t="inlineStr"><is><t>${v}</t></is></c>`)).join('')}</row>`;
    const v: (string | number | null)[] = new Array(19).fill(null);
    v[4] = 'c9'; v[6] = 'Cliente'; v[7] = 'text'; v[10] = SERIAL_REF;
    const raw = enc.encode(
      `<worksheet><sheetData>${celdas(1, movidas)}${celdas(2, v)}</sheetData></worksheet>`,
    );
    const { porChat } = leerHojaMensajes(raw, []);
    expect(porChat.get('c9')?.[0].rol).toBe('Cliente');
  });

  it('descarta filas sin chat o sin fecha en vez de inventarlas', () => {
    const { porChat, filas } = leerHojaMensajes(hoja([
      mensaje(2, { chat: '', rol: 'Cliente', tipo: 'text', serial: SERIAL_REF }),
      mensaje(3, { chat: 'c1', rol: 'Cliente', tipo: 'text', serial: 0 }),
      mensaje(4, { chat: 'c1', rol: 'Cliente', tipo: 'text', serial: SERIAL_REF }),
    ]), []);
    expect(filas).toBe(3);          // se LEYERON las tres
    expect(porChat.size).toBe(1);   // pero solo una es utilizable
    expect(porChat.get('c1')).toHaveLength(1);
  });

  it('deja cada chat ordenado en el tiempo', () => {
    const { porChat } = leerHojaMensajes(hoja([
      mensaje(2, { chat: 'c1', rol: 'Cliente', tipo: 'text', serial: SERIAL_REF + 2 }),
      mensaje(3, { chat: 'c1', rol: 'Propietario', tipo: 'template', serial: SERIAL_REF }),
      mensaje(4, { chat: 'c1', rol: 'Cliente', tipo: 'button', texto: 'CONFIRMAR PEDIDO', serial: SERIAL_REF + 1 }),
    ]), []);
    const t = porChat.get('c1')!.map((m) => m.fecha.getTime());
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(porChat.get('c1')![0].rol).toBe('Propietario');
  });

  it('las filas se leen enteras aunque un mensaje caiga justo en el corte del trozo', () => {
    // El archivo real se recorre de a 1 MB. Una fila partida entre dos trozos
    // se perdería en silencio: con `chunk` chico se fuerza ese caso.
    const filas = Array.from({ length: 40 }, (_, i) =>
      mensaje(i + 2, { chat: `c${i % 7}`, rol: 'Cliente', tipo: 'text', serial: SERIAL_REF + i, ruido: 'x'.repeat(120) }));
    const { porChat, filas: n } = leerHojaMensajes(hoja(filas), [], { chunk: 64 });
    expect(n).toBe(40);
    expect([...porChat.values()].reduce((a, v) => a + v.length, 0)).toBe(40);
  });
});

describe('lectura EN FLUJO — la hoja de 55 MB no puede existir en memoria', () => {
  // ⛔ Por qué existe este modo: corriendo el sync, la plataforma responde
  // HTTP 546 WORKER_RESOURCE_LIMIT — "not having enough compute resources".
  // No es inferencia, es el error. Descomprimir la hoja entera (55 MB) más el
  // zip (9 MB) no entra en el worker. En flujo, lo único que crece es el mapa.
  // El riesgo nuevo es el CORTE: los trozos del descompresor caen donde caen.

  it('un trozo que parte una fila al medio no pierde el mensaje', () => {
    const raw = hoja([
      mensaje(2, { chat: 'c1', rol: 'Cliente', tipo: 'text', serial: SERIAL_REF }),
      mensaje(3, { chat: 'c2', rol: 'Propietario', tipo: 'template', serial: SERIAL_REF }),
    ]);
    // Trozos de 7 bytes: garantizado que casi todas las filas quedan partidas.
    const lector = crearLectorHoja([]);
    for (let i = 0; i < raw.length; i += 7) lector.empujar(raw.subarray(i, i + 7));
    const { porChat, filas } = lector.fin();
    expect(filas).toBe(2);
    expect([...porChat.keys()].sort()).toEqual(['c1', 'c2']);
  });

  it('un carácter UTF-8 partido entre dos trozos se reconstruye', () => {
    // El emoji son 4 bytes; cortar por la mitad con un decoder sin `stream`
    // mete un � y el chat deja de matchear con el pedido, en silencio.
    const raw = hoja([
      mensaje(2, { chat: 'señor-😀-ñ', rol: 'Cliente', tipo: 'button', texto: 'CONFIRMAR PEDIDO', serial: SERIAL_REF }),
    ]);
    const lector = crearLectorHoja([]);
    for (let i = 0; i < raw.length; i += 3) lector.empujar(raw.subarray(i, i + 3));
    const { porChat } = lector.fin();
    expect([...porChat.keys()]).toEqual(['señor-😀-ñ']);
    expect(porChat.get('señor-😀-ñ')![0].texto).toBe('CONFIRMAR PEDIDO');
  });

  it('en flujo da EXACTAMENTE lo mismo que leyendo la hoja entera', () => {
    const filas = Array.from({ length: 60 }, (_, i) =>
      mensaje(i + 2, {
        chat: `c${i % 9}`, rol: i % 3 === 0 ? 'Propietario' : 'Cliente',
        tipo: i % 5 === 0 ? 'button' : 'text', texto: 'CONFIRMAR PEDIDO',
        serial: SERIAL_REF + i, ruido: 'z'.repeat(80),
      }));
    const raw = hoja(filas);
    const entero = leerHojaMensajes(raw, []);
    const lector = crearLectorHoja([]);
    for (let i = 0; i < raw.length; i += 13) lector.empujar(raw.subarray(i, i + 13));
    const flujo = lector.fin();
    expect(flujo.filas).toBe(entero.filas);
    expect(JSON.stringify([...flujo.porChat])).toBe(JSON.stringify([...entero.porChat]));
  });

  it('una hoja vacía no rompe el lector', () => {
    const lector = crearLectorHoja([]);
    const { porChat, filas } = lector.fin();
    expect(filas).toBe(0);
    expect(porChat.size).toBe(0);
  });
});

describe('el vencimiento — morir con mensaje en vez de que te maten', () => {
  it('corta con LecturaVencida y dice cuántas filas alcanzó', () => {
    // ⛔ Sin esto la plataforma mataba la función SIN catch: la fila de
    // sync_logs quedaba en 'running' para siempre y desde afuera era idéntica
    // a "nunca corrió". 82 de 197 corridas terminaron así.
    const filas = Array.from({ length: 200 }, (_, i) =>
      mensaje(i + 2, { chat: `c${i}`, rol: 'Cliente', tipo: 'text', serial: SERIAL_REF, ruido: 'y'.repeat(200) }));
    expect(() => leerHojaMensajes(hoja(filas), [], { vencimiento: Date.now() - 1, chunk: 128 }))
      .toThrow(LecturaVencida);
  });

  it('sin vencimiento no corta nada', () => {
    const { filas } = leerHojaMensajes(hoja([
      mensaje(2, { chat: 'c1', rol: 'Cliente', tipo: 'text', serial: SERIAL_REF }),
    ]), []);
    expect(filas).toBe(1);
  });
});

describe('textos compartidos', () => {
  it('resuelve celdas t="s" contra la tabla', () => {
    const ss = enc.encode('<sst><si><t>ID Receptor</t></si><si><t>c1</t></si></sst>');
    const shared = parsearSharedStrings(ss);
    expect(shared).toEqual(['ID Receptor', 'c1']);
  });

  it('avisa si aparecen celdas compartidas y la tabla vino vacía', () => {
    // Sin este aviso, un cambio de formato del export dejaría TODOS los valores
    // en blanco y la corrida informaría "success" con cero señal.
    const raw = enc.encode(
      `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    );
    const { sharedFaltante } = leerHojaMensajes(raw, []);
    expect(sharedFaltante).toBe(true);
  });
});

describe('piezas sueltas', () => {
  it('letraDeRef saca la columna sin regex', () => {
    expect(letraDeRef('r="A1"')).toBe('A');
    expect(letraDeRef('r="AB12345" t="s"')).toBe('AB');
    expect(letraDeRef('t="s"')).toBe('');
  });

  it('desescapar corta en seco si no hay & (lo que baja el costo del parser)', () => {
    expect(desescapar('hola')).toBe('hola');
    expect(desescapar('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
    expect(desescapar('&#128512;')).toBe('😀');
  });

  it('serialAFecha rechaza lo que no es un serial de Excel', () => {
    // La versión vieja le pasaba el serial a un parser de TEXTO: null para
    // TODAS las filas, historial vacío, todo "sin_dato", y ni un error visible.
    expect(serialAFecha('2026-08-24 20:50:56')).toBeNull();
    expect(serialAFecha('')).toBeNull();
    expect(serialAFecha('999')).toBeNull();
    expect(serialAFecha(String(SERIAL_REF))?.toISOString()).toBe('2026-08-24T20:50:55.680Z');
  });

  it('las columnas usadas son las 6 que alguien lee de verdad', () => {
    expect([...COLUMNAS_USADAS]).toHaveLength(6);
  });
});
