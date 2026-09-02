import { describe, it, expect } from 'vitest';
import { sugerirValores, faltantes, renderizar, type DatosPedido, type PlantillaMeta } from '../../supabase/functions/_shared/plantillasMeta';
import { plantillaParaAccion, accionDePlantilla } from './accionSeguimiento';
import { PLANTILLAS_CO } from './plantillasCuentaCO.fixture';
import { PLANTILLAS_EC } from './plantillasCuentaEC.fixture';

/**
 * El botón de "mandarlo de una" en COLOMBIA.
 *
 * ── Qué reportó el dueño (2-sep-2026) ───────────────────────────────────────
 * *"en Ecuador tenemos para mandar las plantillas de un solo clic; acá en
 * Colombia, en Seguimiento, no está"*. Y era cierto: medido contra la cuenta
 * real, de las 11 fases del tablero **8 no tenían ninguna plantilla que
 * Guardian pudiera completar**, así que `AccionPrincipal` devolvía el fallback
 * y la asesora solo veía la botonera declarativa.
 *
 * No era que faltara el código —la ruta a `chateapro-plantillas` ya existía—
 * sino que las dos piezas que ELIGEN y COMPLETAN la plantilla estaban escritas
 * con la forma de las plantillas de Ecuador:
 *
 *   1. Los patrones de `ACCION_POR_FASE` buscaban `retiro_agencia*` y
 *      `en_camino_hoy`; Colombia las llama `seguimiento_*_oficina*` y
 *      `seguimiento_en_reparto*`.
 *   2. `sugerirValores` leía "Etiqueta: {{n}}" y el `example` de Meta.
 *      Chatea Pro no manda ejemplos ("w", "qw") y sus plantillas hablan en
 *      prosa ("tu envío con guía {{2}}").
 *
 * ⛔ Esta prueba corre sobre la cuenta REAL de las dos empresas y exige las dos
 * cosas a la vez: que Colombia pueda mandar, y que **Ecuador no se mueva ni una
 * coma** — el fixture de EC está al lado justamente para eso.
 */

const PEDIDO_CO: DatosPedido = {
  nombre: 'LIMANEZA LIBRERO GALVIS',
  guia: '114015511499',
  transportadora: 'ENVIA',
  ciudad: 'CALI',
  direccion: 'CL 44 # 12-30 BARRIO EL PRADO',
  producto: 'Nuevo modelo- 6066',
  valor: '169.900',
};

const completable = (p: PlantillaMeta) =>
  faltantes(p, sugerirValores(p, PEDIDO_CO)).length === 0;

const elegida = (estado: string) => plantillaParaAccion(PLANTILLAS_CO, estado, completable);

const previa = (estado: string) => {
  const p = elegida(estado);
  return p ? renderizar(p.cuerpo, sugerirValores(p, PEDIDO_CO)) : null;
};

describe('Colombia: las cuatro columnas del tablero pueden mandar', () => {
  /**
   * La columna más grande del tablero el día que se reportó (8 pedidos).
   * Antes elegía `novedad_reclamo_oficina_1_utilidad` —que anuncia una NOVEDAD,
   * no que el paquete esté listo— y encima no se podía completar, así que no
   * salía ningún botón.
   */
  it('RECLAME EN OFICINA manda la de oficina, con guía y transportadora', () => {
    const p = elegida('RECLAME EN OFICINA');
    expect(p?.nombre).toBe('seguimiento_reclamo_oficina_1_utilidad');
    const t = previa('RECLAME EN OFICINA')!;
    expect(t).toContain('114015511499');
    expect(t).toContain('ENVIA');
    expect(t).toContain('Limaneza');
    // ⛔ Y NO puede quedar ningún hueco crudo a la vista del cliente.
    expect(t).not.toMatch(/\{\{\d+\}\}/);
  });

  it('EN REPARTO manda la de reparto, con dirección y valor', () => {
    const p = elegida('EN REPARTO');
    expect(p?.nombre).toBe('seguimiento_en_reparto_v2');
    const t = previa('EN REPARTO')!;
    expect(t).toContain('CL 44 # 12-30 BARRIO EL PRADO');
    expect(t).toContain('169.900');
    expect(t).not.toMatch(/\{\{\d+\}\}/);
  });

  it('NOVEDAD e INTENTO DE ENTREGA tienen algo que mandar', () => {
    expect(elegida('NOVEDAD')?.nombre).toBe('novedad_recordatorio_v2');
    expect(elegida('INTENTO DE ENTREGA')?.nombre).toBe('novedad_recordatorio_v2');
  });

  it('la cola de confirmación manda la de confirmación', () => {
    const p = elegida('PENDIENTE');
    expect(p?.nombre).toMatch(/^confirmacion/);
    expect(previa('PENDIENTE')).not.toMatch(/\{\{\d+\}\}/);
  });
});

describe('⛔ el botón dice lo que manda, y firma lo que hizo', () => {
  /**
   * En Colombia la única plantilla de novedad que se puede completar es un
   * RECORDATORIO: no pregunta la dirección ni coordina nada. Con la etiqueta de
   * la fase, el botón decía «Preguntarle la dirección» y anotaba «Coordiné
   * nueva entrega» sobre un mensaje que no hace ninguna de las dos cosas —
   * exactamente el bug que ya costó caro en las fases de guía de Ecuador.
   */
  it('un recordatorio no se anuncia como una pregunta', () => {
    const p = elegida('NOVEDAD')!;
    const a = accionDePlantilla('NOVEDAD', p.nombre)!;
    expect(a.etiqueta).toBe('Recordarle que su pedido está frenado');
    expect(a.gestion).toBe('Le recordé la novedad');
    // Y el texto que sale efectivamente recuerda, no pregunta.
    expect(previa('NOVEDAD')).toContain('recordarte');
  });

  it('cuando la plantilla SÍ hace lo que promete la fase, manda la fase', () => {
    const p = elegida('RECLAME EN OFICINA')!;
    const a = accionDePlantilla('RECLAME EN OFICINA', p.nombre)!;
    expect(a.etiqueta).toBe('Avisarle que llegó a la agencia');
    expect(a.gestion).toBe('Avisé: en oficina');
  });

  it('sin plantilla elegida todavía, se dice el texto de la fase', () => {
    expect(accionDePlantilla('EN REPARTO', null)?.etiqueta).toBe('Avisarle que le llega hoy');
  });
});

describe('las fases sin plantilla en la cuenta se apagan, no inventan', () => {
  /**
   * Esto NO es un bug del código: la cuenta de Colombia no tiene plantilla de
   * rescate de devolución, y sus tres de guía traen un botón con enlace
   * variable que Guardian no puede armar. El botón se esconde y queda la
   * botonera declarativa — mejor sin botón que un botón que miente.
   */
  it.each(['EN TRANSITO', 'GUIA GENERADA', 'DEVOLUCION', 'DEVOLUCION EN TRANSITO'])(
    '%s no ofrece nada',
    (estado) => { expect(elegida(estado)).toBeNull(); },
  );

  it('las tres de guía están bloqueadas por su botón con enlace, no elegidas por error', () => {
    const guias = PLANTILLAS_CO.filter((p) => /guia_generada/.test(p.nombre));
    expect(guias.length).toBe(3);
    for (const g of guias) expect(g.noSoportada).toBeTruthy();
  });
});

describe('⛔ Ecuador no se movió', () => {
  const PEDIDO_EC: DatosPedido = {
    nombre: 'MARIA JOSE PEREZ', guia: 'V123456789', transportadora: 'SERVIENTREGA',
    ciudad: 'GUAYAQUIL', direccion: 'Av. Machala 123 y Portete',
    producto: 'Gafas Inteligentes G58', valor: '45.90',
    rastreoUrl: 'https://www.servientrega.com.ec/Tracking/?guia=V123456789',
  };
  const elegidaEc = (estado: string) => plantillaParaAccion(
    PLANTILLAS_EC, estado,
    (p) => faltantes(p, sugerirValores(p, PEDIDO_EC)).length === 0,
  );

  /**
   * Los patrones nuevos (`seguimiento_en_oficina`, `en_reparto`) y las pistas
   * nuevas de `sugerirValores` (guía, dirección, ciudad, transportadora, valor)
   * se agregaron para Colombia. Acá se fija que en Ecuador elijan lo mismo de
   * siempre: el que cambie uno de los dos lados sin querer, rompe esta prueba.
   */
  it.each([
    ['EN OFICINA', 'retiro_agencia_v1'],
    ['NOVEDAD', 'novedad_reprogramar_v1'],
    ['EN REPARTO', 'en_camino_hoy_v2'],
    ['GUIA GENERADA', 'guia_generada_v1'],
    ['PENDIENTE', 'antes_generar_guia_k1'],
    ['DEVOLUCION', 'rescate_devolucion_v1'],
    ['RECHAZADO', 'rescate_devolucion_v1'],
  ])('%s sigue eligiendo %s', (estado, esperada) => {
    expect(elegidaEc(estado)?.nombre).toBe(esperada);
  });

  it('el link de rastreo sigue siendo un LINK y no el número de guía', () => {
    // El bug de agosto que llegó a clientes reales: "seguí tu envío aquí 👉
    // V123456789". La pista nueva de `guía` no puede reintroducirlo.
    const p = elegidaEc('GUIA GENERADA')!;
    const t = renderizar(p.cuerpo, sugerirValores(p, PEDIDO_EC));
    expect(t).toContain('https://www.servientrega.com.ec/Tracking/');
    expect(t).not.toMatch(/👉\s*V123456789/);
  });
});
