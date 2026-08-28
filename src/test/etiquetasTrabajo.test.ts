import { describe, it, expect } from 'vitest';
import { GLOSARIO_ETIQUETAS, etiquetasDe } from '@/lib/etiquetasTrabajo';
import { RIESGO_INFO, type NivelRiesgo } from '@/lib/riesgoChat';

/**
 * GUARDIÁN del glosario de etiquetas.
 *
 * Pedido del dueño (28-ago-2026): *"que puedan diferenciar y coincidir en las
 * etiquetas"*. La página `/como-se-trabaja` es la traducción entre lo que dice
 * Llamada y lo que dice Seguimiento. Una etiqueta nueva que no llegue ahí deja
 * al equipo otra vez adivinando — el mismo trato que ya tienen los escalones de
 * la escalera y las listas SLA.
 */

describe('el glosario cubre TODAS las etiquetas de Llamada', () => {
  it('⛔ ningún nivel de riesgo puede quedar sin explicar', () => {
    // Si alguien agrega un nivel a RIESGO_INFO y no lo documenta, esto falla.
    const enGlosario = new Set(etiquetasDe('llamada').map((e) => e.etiqueta));
    for (const nivel of Object.keys(RIESGO_INFO) as NivelRiesgo[]) {
      expect(
        enGlosario.has(RIESGO_INFO[nivel].etiqueta),
        `El nivel "${nivel}" ("${RIESGO_INFO[nivel].etiqueta}") no está en el glosario. `
        + 'Agregalo en DE_LLAMADA (etiquetasTrabajo.ts).',
      ).toBe(true);
    }
  });

  it('el texto NO se copia: sale de RIESGO_INFO', () => {
    // Dos copias del mismo texto se desincronizan el día que alguien cambia una.
    for (const nivel of Object.keys(RIESGO_INFO) as NivelRiesgo[]) {
      const e = etiquetasDe('llamada').find((x) => x.clave === `llamada-${nivel}`);
      expect(e?.etiqueta).toBe(RIESGO_INFO[nivel].etiqueta);
      expect(e?.queHacer).toBe(RIESGO_INFO[nivel].queHacer);
    }
  });
});

describe('cada entrada está completa y es usable', () => {
  it('nadie queda sin qué mide ni sin qué hacer', () => {
    for (const e of GLOSARIO_ETIQUETAS) {
      expect(e.etiqueta.trim().length, `${e.clave} sin etiqueta`).toBeGreaterThan(0);
      expect(e.que.trim().length, `${e.clave} no dice QUÉ mide`).toBeGreaterThan(15);
      expect(e.queHacer.trim().length, `${e.clave} no dice QUÉ HACER`).toBeGreaterThan(15);
    }
  });

  it('las claves son únicas (los anclajes de la página dependen de eso)', () => {
    const claves = GLOSARIO_ETIQUETAS.map((e) => e.clave);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it('hay etiquetas de las DOS pantallas', () => {
    expect(etiquetasDe('llamada').length).toBeGreaterThan(0);
    expect(etiquetasDe('seguimiento').length).toBeGreaterThan(0);
  });
});

describe('⛔ la traducción entre pantallas no puede apuntar al vacío', () => {
  it('todo `equivaleA` existe de verdad en la otra pantalla', () => {
    // Mandar a la asesora a buscar una etiqueta que no existe es peor que no
    // ofrecerle traducción: la deja creyendo que se le pasó algo.
    for (const e of GLOSARIO_ETIQUETAS) {
      if (!e.equivaleA) continue;
      const otra = e.pantalla === 'llamada' ? 'seguimiento' : 'llamada';
      const existe = etiquetasDe(otra).some((x) => x.etiqueta.includes(e.equivaleA as string));
      expect(existe, `"${e.clave}" dice equivaler a «${e.equivaleA}», que no existe en ${otra}.`).toBe(true);
    }
  });
});

describe('⛔ la contradicción que originó esto no puede volver', () => {
  it('el chip de "no confirmó" NO puede llamarse "No respondió"', () => {
    // 28-ago-2026: `frio` decía "No respondió" —que mide si el cliente apretó el
    // botón de confirmar de ESE pedido— justo al lado de "el cliente escribió y
    // sigue sin respuesta", que mira toda la conversación. Las dos ciertas,
    // leídas como opuestas. Ver el comentario en riesgoChat.ts.
    expect(RIESGO_INFO.frio.etiqueta).not.toMatch(/no respondi/i);
  });
});
