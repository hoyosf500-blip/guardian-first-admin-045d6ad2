import { describe, it, expect } from 'vitest';
import { accionPrincipal, plantillaParaAccion } from './accionSeguimiento';
import { sugerirValores, faltantes, renderizar, type DatosPedido } from './plantillasMeta';
import { PLANTILLAS_EC } from './plantillasCuentaEC.fixture';

/**
 * ⛔ GUARDIÁN: "para cada estatus debe tener su plantilla ya, para que no
 * piensen" (dueño, 28-ago-2026).
 *
 * No es un unit test: corre las plantillas REALES de la cuenta de Ecuador
 * contra un pedido completo y exige que cada fase con acción pueda mandar algo.
 * Una fase que no pueda, tiene que estar declarada abajo CON SU MOTIVO — así
 * "no hay plantilla" es una decisión escrita y no un botón que desaparece sin
 * que nadie se entere.
 *
 * Y además revisa lo que va a LEER el cliente, porque las dos veces que esto
 * falló en producción el código estaba en verde: el mensaje se mandaba, solo
 * que decía cualquier cosa.
 */

const PEDIDO: DatosPedido = {
  nombre: 'JUAN PEREZ LOPEZ',
  guia: 'V123456789',
  transportadora: 'SERVIENTREGA',
  ciudad: 'DURAN',
  producto: 'GAFAS BLUETOOH PR',
  valor: '$68,60',
  rastreoUrl: 'https://www.servientrega.com.ec/Tracking/?tipo=GUIA&guia=V123456789',
};

const completable = (p: (typeof PLANTILLAS_EC)[number]) =>
  faltantes(p, sugerirValores(p, PEDIDO)).length === 0;

const elegida = (estado: string) => plantillaParaAccion(PLANTILLAS_EC, estado, completable);

/** Un estado de Dropi por cada fase que `ACCION_POR_FASE` cubre. */
const ESTADO_DE_FASE: Record<string, string> = {
  oficina: 'EN OFICINA',
  guia: 'GUIA GENERADA',
  bodega_trans: 'EN BODEGA TRANSPORTADORA',
  reparto: 'EN REPARTO',
  transito: 'EN TRANSITO',
  novedad: 'NOVEDAD',
  novedad_sol: 'NOVEDAD SOLUCIONADA',
  // ⚠️ 'PENDIENTE CONFIRMACION' NO es esta fase — cae en 'otros'
  // (`segStatus.ts`), que no tiene acción. El estado real de esta fase es el
  // tramo pre-guía. Escribirlo mal hacía que el test probara el vacío.
  procesamiento: 'EN PROCESAMIENTO',
  devolucion: 'DEVOLUCION',
  devolucion_transito: 'DEVOLUCION EN TRANSITO',
  rechazado: 'RECHAZADO',
};

/**
 * Fases que hoy NO pueden mandar nada, con el motivo. Vaciar esta lista es la
 * meta; agregarle una fase sin motivo, no.
 */
const SIN_PLANTILLA_TODAVIA: Record<string, string> = {
  transito:
    'La cuenta EC no tiene una plantilla de TRÁNSITO que Guardian pueda completar: '
    + '`en_transito_v2` pide el número de orden interno y la ciudad, y ninguno de los dos '
    + 'sale del texto. NO se le presta la de "llega hoy": prometer una entrega que no '
    + 'llega es la vía corta a que el cliente cancele. Se arregla en Meta, cambiando esos '
    + 'dos huecos por producto y ciudad etiquetada.',
};

describe('⛔ cada estatus tiene su plantilla lista', () => {
  for (const [fase, estado] of Object.entries(ESTADO_DE_FASE)) {
    it(`${fase} (${estado})`, () => {
      // La fase tiene que existir en el mapa de acciones, o el estado de arriba
      // quedó viejo y el test estaría probando el vacío.
      expect(accionPrincipal(estado), `${estado} debería tener acción`).not.toBeNull();
      const p = elegida(estado);
      if (SIN_PLANTILLA_TODAVIA[fase]) {
        expect(p, `${fase} está declarada sin plantilla: ${SIN_PLANTILLA_TODAVIA[fase]}`).toBeNull();
        return;
      }
      expect(p, `${fase} se quedó sin plantilla mandable`).not.toBeNull();
      // Y que salga ENTERA: sin huecos, es lo que ve el cliente.
      expect(renderizar(p!.cuerpo, sugerirValores(p!, PEDIDO))).not.toMatch(/\[falta \d+\]/);
    });
  }

  it('ninguna fase sin acción aparece en la lista de excepciones', () => {
    for (const fase of Object.keys(SIN_PLANTILLA_TODAVIA)) {
      expect(Object.keys(ESTADO_DE_FASE)).toContain(fase);
    }
  });
});

describe('⛔ lo que le llega al cliente (los dos bugs que sí salieron)', () => {
  it('EN OFICINA manda la que lo NOMBRA, no la que dice "agencia: SERVIENTREGA"', () => {
    // Historia: `retiro_agencia_v1` era imposible de completar ("Estimado/a
    // {{1}}", "su {{2}}" — ninguna regla los agarraba), así que ganaba
    // `retiro_agencia_k1` y al cliente le llegaba, textual:
    //   "Estimado Cliente: Servientrega le notifica que su pedido esta listo
    //    para ser retirado en agencia: SERVIENTREGA"
    // Sin nombre, sin producto, y sin decirle a QUÉ agencia ir.
    const p = elegida('EN OFICINA')!;
    expect(p.nombre).toBe('retiro_agencia_v1');
    const texto = renderizar(p.cuerpo, sugerirValores(p, PEDIDO));
    expect(texto).toContain('Juan');
    expect(texto).toContain('GAFAS BLUETOOH PR');
    expect(texto).not.toMatch(/agencia: SERVIENTREGA/i);
  });

  it('GUIA GENERADA manda un LINK, nunca el número de guía disfrazado de link', () => {
    // Historia: el hueco del link no tiene etiqueta y su ejemplo es una URL que
    // contiene "tracking", así que lo agarraba la regla de guía. Al cliente le
    // llegaba "Puede seguir su envío en todo momento aquí 👉 V123456789".
    const p = elegida('GUIA GENERADA')!;
    const texto = renderizar(p.cuerpo, sugerirValores(p, PEDIDO));
    expect(texto).toContain('https://');
    expect(texto).not.toMatch(/👉\s*V123456789/);
  });

  it('sin link de rastreo NO se manda la guía pelada: la plantilla se salta', () => {
    // Preferimos quedarnos sin botón antes que mandar un link roto. Con la
    // transportadora desconocida, `conRastreo` no arma nada y este es el efecto.
    const sinLink = { ...PEDIDO, rastreoUrl: null };
    const p = plantillaParaAccion(PLANTILLAS_EC, 'GUIA GENERADA',
      (x) => faltantes(x, sugerirValores(x, sinLink)).length === 0);
    if (p) expect(renderizar(p.cuerpo, sugerirValores(p, sinLink))).not.toContain('V123456789');
  });

  it('EN REPARTO prefiere la que PREGUNTA — el objetivo es que contesten', () => {
    // `en_camino_hoy_v1` y `_v2` dicen lo mismo; la _v2 termina en "¿Estará
    // disponible hoy para recibirlo?" con botones de un toque. Antes ganaba la
    // _v1 por el orden alfabético de Meta.
    const p = elegida('EN REPARTO')!;
    expect(p.nombre).toBe('en_camino_hoy_v2');
    expect(p.botones.length).toBeGreaterThan(0);
  });

  it('EN TRANSITO NO puede ofrecer "hoy es el día"', () => {
    // Su plantilla propia no se puede completar y la de "llega hoy" NO se le
    // presta: mejor sin botón que un botón que promete una entrega falsa.
    expect(elegida('EN TRANSITO')).toBeNull();
  });

  it('una plantilla bloqueada por Meta nunca se elige', () => {
    // `guia_generada_k1` lleva un botón con enlace variable que Guardian no arma.
    for (const estado of Object.values(ESTADO_DE_FASE)) {
      expect(elegida(estado)?.noSoportada ?? null).toBeNull();
    }
  });
});
