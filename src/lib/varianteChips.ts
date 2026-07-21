/**
 * Parte la variante que manda Dropi ("AZUL / 37", "NEGRO X BLANCO / 37") en
 * piezas que la asesora pueda leer de un vistazo mientras habla por teléfono.
 *
 * Dropi NO dice cuál atributo es la talla y cuál el color: manda los valores
 * sueltos separados por " / ". Etiquetar es útil ("Talla 37" se lee mejor que
 * "37") pero etiquetar MAL es peor que no etiquetar: si la asesora le dice al
 * cliente "color 37" pierde la venta.
 *
 * Por eso sólo se etiqueta cuando la lectura es inequívoca: exactamente dos
 * valores y exactamente uno de ellos es un número (las tallas de calzado son
 * numéricas; los colores nunca lo son). Cualquier otra combinación —una sola
 * pieza, tres piezas, dos números, dos textos— se muestra tal cual, sin
 * inventar una etiqueta que podría estar al revés.
 */
export interface VarianteChip {
  /** 'Talla' | 'Color' sólo cuando se puede afirmar; si no, se omite. */
  etiqueta?: 'Talla' | 'Color';
  valor: string;
}

/** Talla de calzado/ropa: 37, 8, 40.5, 8,5. Nunca un color. */
const SOLO_NUMERO = /^\d{1,3}([.,]\d{1,2})?$/;

export function describirVariante(variante?: string | null): VarianteChip[] {
  const partes = String(variante ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  if (partes.length === 0) return [];

  if (partes.length === 2) {
    const numericas = partes.filter((p) => SOLO_NUMERO.test(p));
    if (numericas.length === 1) {
      return partes.map((valor) => ({
        etiqueta: SOLO_NUMERO.test(valor) ? ('Talla' as const) : ('Color' as const),
        valor,
      }));
    }
  }

  return partes.map((valor) => ({ valor }));
}
