import { describe, it, expect } from 'vitest';
import { idWhatsapp, last9 } from '../../supabase/functions/_shared/chateaproApi';

/**
 * El teléfono es el ÚNICO puente entre Guardian y Chatea Pro. Si falla, la
 * asesora ve "este cliente nunca escribió" sobre una conversación que existe —
 * o, peor, la conversación de OTRA persona.
 *
 * ⛔ Medido el 2-sep-2026 contra la cuenta real: el mismo cliente puede estar
 * guardado de dos formas distintas según CÓMO nació el contacto.
 *   - escribió él primero  → `3143048595`     (nacional, 10 dígitos)
 *   - lo creó la API       → `+573209498426`  (internacional, con +)
 * Y la búsqueda de Chatea Pro NO es por subcadena: cada forma hay que pedirla
 * tal cual.
 */
describe('el teléfono, puente entre Guardian y Chatea Pro', () => {
  it('arma el id de WhatsApp desde el nacional colombiano', () => {
    expect(idWhatsapp('3209498426', 'CO')).toBe('573209498426');
    expect(idWhatsapp('320 949 8426', 'CO')).toBe('573209498426');
  });

  it('no duplica el indicativo si ya viene', () => {
    expect(idWhatsapp('+573209498426', 'CO')).toBe('573209498426');
    expect(idWhatsapp('573209498426', 'CO')).toBe('573209498426');
  });

  it('respeta el país', () => {
    expect(idWhatsapp('0987654321', 'EC')).toBe('593987654321');
    expect(idWhatsapp('55551234', 'GT')).toBe('50255551234');
  });

  it('sin país conocido asume Colombia, que es donde corre Chatea Pro', () => {
    expect(idWhatsapp('3209498426', '')).toBe('573209498426');
  });

  it('los últimos 9 son la clave de confirmación, no la de búsqueda', () => {
    // Las tres formas del MISMO cliente comparten los últimos 9: por eso sirven
    // para confirmar un match, aunque ninguna sirva sola para buscarlo.
    expect(last9('+573209498426')).toBe(last9('3209498426'));
    expect(last9('573209498426')).toBe(last9('320 949 8426'));
  });
});
