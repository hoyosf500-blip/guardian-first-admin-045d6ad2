import { describe, it, expect } from 'vitest';
import {
  accionPrincipal, etiquetaPlantilla, nombreVisible, partirPlantillas,
  plantillaParaAccion, MAX_RECOMENDADAS,
} from './accionSeguimiento';
import { metodosParaEstado } from './segMetodosEstado';

// Los nombres REALES de la cuenta de Ecuador, leídos de la pantalla el
// 27-ago-2026. Se usan tal cual (con sus typos: `novedadk2` sin guion bajo,
// `remarketin1` sin la g) porque son los que hay que reconocer de verdad.
const CUENTA_EC = [
  'retiro_agencia_disponible_k1', 'retiro_agencia_k1', 'retiro_agencia_recordatorio_k2',
  'retiro_agencia_recordatorio_k3', 'retiro_agencia_v1', 'antes_generar_guia_k1',
  'confirmacion_datos_v1', 'confirmacion_pedido_k1', 'ecommerce', 'en_camino_hoy_v1',
  'en_camino_hoy_v2', 'en_transito_v2', 'guia_generada_k1', 'guia_generada_v1',
  'novedad_k1', 'novedad_k2', 'novedadk2', 'recordatorio_confirmacion_k1',
  'remarketin1_ecomm', 'remarketin3_ecomm', 'remarketing2_ecommm', 'remarketing4_ecomm',
  'ultima_oportunidad_v1', 'zona_entrega_k1', 'carritos_abandonados',
  'carritos_abandonados_v2', 'direccion_incompleta', 'entregado_gracias_v1',
  'reconfirmacion', 'remarketing_descuento_aprobado', 'remarketing_despacho_listo',
  'remarketing_envio_gratis', 'remarketing_k1', 'remarketing_k2', 'remarketing_k3',
  'remarketing_stock_agotado', 'remarketing_stock_apartado', 'remarketing_v1',
  'rescate_devolucion_v1', 'seguimiento_reactivar_v1',
].map((nombre) => ({ nombre }));

describe('accionPrincipal', () => {
  it('un pedido en agencia se avisa, y el botón lo dice en español', () => {
    const a = accionPrincipal('PARA RETIRO EN AGENCIA SERVIENTREGA');
    expect(a?.etiqueta).toBe('Avisarle que llegó a la agencia');
  });

  it('clasifica por FASE, no por el texto exacto de Dropi', () => {
    // Dropi EC inventa rótulos sin avisar; todos estos son la misma situación.
    for (const e of ['EN OFICINA', 'RECLAME EN OFICINA', 'EN DISTRIBUCION PARA ENTREGA EN AGENCIA']) {
      expect(accionPrincipal(e)?.etiqueta).toBe('Avisarle que llegó a la agencia');
    }
  });

  it('cada fase tiene su acción propia, no una genérica', () => {
    expect(accionPrincipal('GUIA GENERADA')?.etiqueta).toBe('Mandarle la guía');
    expect(accionPrincipal('EN REPARTO')?.etiqueta).toBe('Avisarle que le llega hoy');
    expect(accionPrincipal('NOVEDAD')?.etiqueta).toBe('Preguntarle la dirección');
  });

  it('⛔ sin acción obvia NO hay botón: entregado, cancelado y desconocido', () => {
    // Un botón grande que manda un WhatsApp sin saber qué decir es peor que
    // ningún botón.
    expect(accionPrincipal('ENTREGADO')).toBeNull();
    expect(accionPrincipal('CANCELADO')).toBeNull();
    expect(accionPrincipal('UN ESTADO QUE DROPI INVENTE MAÑANA')).toBeNull();
    expect(accionPrincipal(null)).toBeNull();
    expect(accionPrincipal('')).toBeNull();
  });

  it('la gestión que registra ya existía en la botonera vieja (el histórico no se parte)', () => {
    // Si el botón nuevo escribiera un texto nuevo, la bitácora tendría dos
    // idiomas para el mismo hecho y `esContactoEfectivo` podría leerlos distinto.
    for (const estado of ['EN OFICINA', 'GUIA GENERADA', 'EN REPARTO', 'NOVEDAD']) {
      const a = accionPrincipal(estado)!;
      expect(metodosParaEstado(estado)).toContain(a.gestion);
    }
  });
});

describe('etiquetaPlantilla', () => {
  it('traduce el identificador de Meta a algo que una persona entiende', () => {
    expect(etiquetaPlantilla('retiro_agencia_k1')).toBe('Avisarle que llegó a la agencia');
    expect(etiquetaPlantilla('guia_generada_v1')).toBe('Mandarle la guía');
  });

  it('⛔ el recordatorio NO se confunde con el primer aviso', () => {
    // Es el orden de la tabla: si `retiro_agencia` ganara primero, la asesora
    // mandaría "se lo devolvemos" creyendo que manda "ya llegó".
    expect(etiquetaPlantilla('retiro_agencia_recordatorio_k3'))
      .toBe('Recordarle que la agencia se lo devuelve');
    expect(etiquetaPlantilla('retiro_agencia_disponible_k1'))
      .toBe('Avisarle que ya lo puede retirar');
  });

  it('tolera los typos reales de la cuenta', () => {
    expect(etiquetaPlantilla('novedadk2')).toBe('Avisarle que no lo pudieron entregar');
    expect(etiquetaPlantilla('remarketin1_ecomm')).toBe('Volver a ofrecerle el producto');
  });

  it('⛔ lo que no reconoce devuelve null — NO una etiqueta genérica', () => {
    // Dos plantillas distintas con el mismo rótulo inventado sería el peor
    // resultado: la asesora no podría distinguirlas y mandaría la equivocada.
    expect(etiquetaPlantilla('promo_navidad_2027')).toBeNull();
    expect(etiquetaPlantilla('')).toBeNull();
    expect(etiquetaPlantilla(null)).toBeNull();
  });

  it('nombreVisible cae al nombre crudo legible, nunca a un invento', () => {
    expect(nombreVisible('promo_navidad_2027')).toBe('promo navidad 2027');
    expect(nombreVisible('retiro_agencia_k1')).toBe('Avisarle que llegó a la agencia');
  });
});

describe('partirPlantillas', () => {
  it('sube las de la fase y deja el resto detrás, sin perder ninguna', () => {
    const { recomendadas, resto } = partirPlantillas(CUENTA_EC, 'PARA RETIRO EN AGENCIA SERVIENTREGA');
    expect(recomendadas.length).toBeGreaterThan(0);
    expect(recomendadas.every((p) => /retiro|agencia/.test(p.nombre))).toBe(true);
    // ⛔ Nada se esconde: recomendadas + resto = la lista entera.
    expect(recomendadas.length + resto.length).toBe(CUENTA_EC.length);
    const nombres = new Set([...recomendadas, ...resto].map((p) => p.nombre));
    expect(nombres.size).toBe(CUENTA_EC.length);
  });

  it('la PRIMERA es la de la situación más específica', () => {
    const { recomendadas } = partirPlantillas(CUENTA_EC, 'EN OFICINA');
    expect(recomendadas[0].nombre).toBe('retiro_agencia_disponible_k1');
  });

  it('nunca ofrece más de las que caben en la tarjeta', () => {
    const { recomendadas } = partirPlantillas(CUENTA_EC, 'EN OFICINA');
    expect(recomendadas.length).toBeLessThanOrEqual(MAX_RECOMENDADAS);
  });

  it('⛔ una plantilla bloqueada NUNCA se recomienda', () => {
    // Ofrecerla arriba y que al tocarla diga "esta se manda desde ImporChat" es
    // peor que no ofrecerla.
    const conBloqueo = [
      { nombre: 'retiro_agencia_disponible_k1', noSoportada: 'Lleva imagen adjunta.' },
      { nombre: 'retiro_agencia_k1' },
    ];
    const { recomendadas, resto } = partirPlantillas(conBloqueo, 'EN OFICINA');
    expect(recomendadas.map((p) => p.nombre)).toEqual(['retiro_agencia_k1']);
    expect(resto.map((p) => p.nombre)).toContain('retiro_agencia_disponible_k1');
  });

  it('una fase sin acción deja todo tal cual, no reordena al azar', () => {
    const { recomendadas, resto } = partirPlantillas(CUENTA_EC, 'ENTREGADO');
    expect(recomendadas).toEqual([]);
    expect(resto.length).toBe(CUENTA_EC.length);
  });

  it('una cuenta sin plantillas que sirvan no rompe ni inventa', () => {
    const otras = [{ nombre: 'promo_navidad' }, { nombre: 'saludo_generico' }];
    const { recomendadas, resto } = partirPlantillas(otras, 'EN OFICINA');
    expect(recomendadas).toEqual([]);
    expect(resto.length).toBe(2);
  });
});

describe('plantillaParaAccion', () => {
  // Todo se puede llenar: el orden es puro criterio de especificidad.
  const todoOk = () => true;

  it('es la misma que la primera recomendada — una sola decisión', () => {
    // El botón grande y la lista tienen que ofrecer LO MISMO: si divergen, la
    // asesora manda una cosa creyendo que manda otra.
    for (const estado of ['EN OFICINA', 'GUIA GENERADA', 'EN REPARTO', 'NOVEDAD']) {
      const { recomendadas } = partirPlantillas(CUENTA_EC, estado, todoOk);
      expect(plantillaParaAccion(CUENTA_EC, estado, todoOk)?.nombre).toBe(recomendadas[0]?.nombre);
    }
  });

  it('sin plantilla que sirva devuelve null (el botón cae al declarativo)', () => {
    expect(plantillaParaAccion([{ nombre: 'promo_navidad' }], 'EN OFICINA', todoOk)).toBeNull();
    expect(plantillaParaAccion(CUENTA_EC, 'ENTREGADO', todoOk)).toBeNull();
  });

  // ── El bug que se vio EN PRODUCCIÓN el 27-ago-2026 ────────────────────────
  // El botón elegía `retiro_agencia_disponible_k1` porque es la más específica,
  // pero pide "Plazo para retirar: {{4}} días" — un dato que Guardian tiene
  // PROHIBIDO inventar. Resultado: cargaba, se daba cuenta de que no podía, y
  // el panel se apagaba solo delante de la asesora.
  describe('⛔ elige la que se PUEDE mandar, no la que suena mejor', () => {
    // Los huecos reales medidos en la cuenta de Ecuador.
    const HUECOS: Record<string, number> = {
      retiro_agencia_disponible_k1: 4, // nombre + agencia + guía + PLAZO EN DÍAS
      retiro_agencia_recordatorio_k2: 4,
      retiro_agencia_recordatorio_k3: 4,
      retiro_agencia_v1: 2,            // nombre + producto → los dos los tenemos
      retiro_agencia_k1: 1,            // agencia
    };
    // Guardian llena nombre, agencia, guía, ciudad, producto y valor; el PLAZO
    // no (`plantillasMeta.ts` no tiene regla para "días", a propósito).
    const sePuede = (p: { nombre: string }) => (HUECOS[p.nombre] ?? 0) <= 2;

    it('no devuelve la que pide un dato que no tenemos', () => {
      const elegida = plantillaParaAccion(CUENTA_EC, 'EN OFICINA', sePuede);
      expect(elegida).not.toBeNull();
      expect(elegida!.nombre).not.toBe('retiro_agencia_disponible_k1');
      expect(sePuede(elegida!)).toBe(true);
    });

    it('las completables suben al frente de las recomendadas', () => {
      const { recomendadas } = partirPlantillas(CUENTA_EC, 'EN OFICINA', sePuede);
      expect(sePuede(recomendadas[0])).toBe(true);
    });

    it('pero las NO completables siguen en la lista — la asesora las llena a mano', () => {
      const { recomendadas, resto } = partirPlantillas(CUENTA_EC, 'EN OFICINA', sePuede);
      const todas = [...recomendadas, ...resto].map((p) => p.nombre);
      expect(todas).toContain('retiro_agencia_disponible_k1');
      expect(todas.length).toBe(CUENTA_EC.length);
    });

    it('si NINGUNA se puede completar devuelve null y el botón cae al declarativo', () => {
      expect(plantillaParaAccion(CUENTA_EC, 'EN OFICINA', () => false)).toBeNull();
    });
  });
});
