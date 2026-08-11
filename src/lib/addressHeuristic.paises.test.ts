import { describe, it, expect } from 'vitest';
import { heuristicValidate } from './addressHeuristic';

// Casos REALES de los tres países donde opera la tienda (CO, EC, GT).
//
// QUÉ VIGILA ESTE ARCHIVO
// El semáforo ya no bloquea el confirmar (`canConfirmOrder`, 2026-05-26), pero
// sigue mandando en lo que la asesora VE: un rojo la manda a discutir con un
// cliente cuya dirección estaba perfecta, y eso quema llamadas. La regla dura
// que se prueba acá es: **ninguna dirección válida de CO, EC o GT puede caer en
// rojo**. El amarillo se tolera (dice "confirmá con el cliente", que nunca es
// mentira); el rojo dice "esto está mal", y sobre una dirección buena es falso.
//
// Guatemala no tiene rama propia en la heurística: entra por el camino
// colombiano. Se probó y funciona porque el formato GT ("12 calle 3-45 zona 1")
// trae tipo de vía y placa con guion, igual que el colombiano. Estas pruebas
// existen para que eso deje de ser una coincidencia afortunada y pase a ser un
// contrato: si alguien endurece la regla de la placa canónica, GT se rompe acá
// y no en el teléfono de una asesora en Quetzaltenango.

/** Los umbrales de `useAddressValidation.decisionFromHeuristic`. Duplicados a
 *  propósito: si allá alguien los mueve, estas pruebas siguen midiendo lo que
 *  el usuario ve hoy y el cambio queda visible en el diff. */
const VERDE = 80;
const ROJO = 50;

function decision(score: number): 'green' | 'yellow' | 'red' {
  if (score >= VERDE) return 'green';
  if (score >= ROJO) return 'yellow';
  return 'red';
}

function evaluar(direccion: string, pais: string) {
  const r = heuristicValidate(direccion, pais);
  return { ...r, decision: r.decision ?? decision(r.score) };
}

// ---------------------------------------------------------------- Colombia

const CO_VALIDAS = [
  'Calle 50 # 23-45 Barrio Laureles',
  'Carrera 7 # 32-16 Apto 502, Bogotá',
  'Cra 43A # 5-15 Edificio Palma, Medellín',
  'Diagonal 25G # 95A-55 Interior 3',
  'Transversal 93 # 53-48 Torre 4 Apto 1203',
  'Av Boyacá # 64C-25 Local 12',
  'Callé 21 # 10-78 Barrio el 12, Fonseca',
];

// ----------------------------------------------------------------- Ecuador

const EC_VALIDAS = [
  'Cdla La Garzota Mz 8 Villa 15, Guayaquil',
  'Av. Amazonas N34-451 y Av. Atahualpa, Quito',
  'Coop Santiaguito Roldos Mz 2141 solar 15, Guayaquil',
  'Urbanización La Joya, etapa Zafiro, casa 23, Daule',
  'Calle Bolívar 12-34 y Sucre, Cuenca',
  'Km 8 vía Samborondón, Conjunto Los Ceibos, villa 40',
];

// --------------------------------------------------------------- Guatemala

/** Formato urbano estándar: "<n> calle/avenida <placa> zona <n>". */
const GT_VALIDAS_URBANAS = [
  '12 calle 3-45 zona 1, Ciudad de Guatemala',
  '5a Avenida 12-45 zona 10, Guatemala',
  'Avenida Petapa 40-15 zona 12',
  '4ta calle A 7-20 zona 3, Quetzaltenango',
  '6a avenida 9-18 zona 1 Edificio El Centro oficina 402',
];

/** Direcciones GT igual de reales, pero SIN placa con guion: colonias, aldeas,
 *  condominios sobre carretera. Son la mayoría fuera de la capital. */
const GT_VALIDAS_SIN_PLACA = [
  'Km 15.5 carretera a El Salvador, Condominio Vistas casa 12',
  'Colonia Primero de Julio, sector 2, casa 45, zona 5 Mixco',
  'Lote 8 manzana C, Aldea San José Pinula',
  'Colonia El Maestro, 8a calle final, casa 3, zona 15',
];

describe('heuristicValidate — Colombia: no marca en rojo una dirección válida', () => {
  it.each(CO_VALIDAS)('«%s» no es roja', (dir) => {
    expect(evaluar(dir, 'CO').decision).not.toBe('red');
  });

  it('la dirección canónica con placa llega a verde', () => {
    expect(evaluar('Calle 50 # 23-45 Barrio Laureles', 'CO').decision).toBe('green');
  });
});

describe('heuristicValidate — Ecuador: no marca en rojo una dirección válida', () => {
  it.each(EC_VALIDAS)('«%s» no es roja', (dir) => {
    expect(evaluar(dir, 'EC').decision).not.toBe('red');
  });

  it('el direccionamiento por manzana/villa NO cae en el amarillo "rural" de Colombia', () => {
    // Regresión de la auditoría 2026-07-07: sin la excepción `!isEC`, toda
    // Guayaquil quedaba amarilla por escribir "Mz 8 Villa 15".
    const r = heuristicValidate('Cdla La Garzota Mz 8 Villa 15, Guayaquil', 'EC');
    expect(r.issues).not.toContain('rural_address');
    expect(r.score).toBeGreaterThanOrEqual(VERDE);
  });

  it('no exige la placa colombiana «# X-Y»', () => {
    const r = heuristicValidate('Urbanización La Joya, etapa Zafiro, casa 23, Daule', 'EC');
    expect(r.issues).not.toContain('no_canonical_placa');
  });
});

describe('heuristicValidate — Guatemala: no marca en rojo una dirección válida', () => {
  it.each([...GT_VALIDAS_URBANAS, ...GT_VALIDAS_SIN_PLACA])('«%s» no es roja', (dir) => {
    expect(evaluar(dir, 'GT').decision).not.toBe('red');
  });

  it.each(GT_VALIDAS_URBANAS)('«%s» llega a verde (calle/avenida + placa con guion)', (dir) => {
    expect(evaluar(dir, 'GT').decision).toBe('green');
  });

  it.each(GT_VALIDAS_SIN_PLACA)('«%s» queda en amarillo, nunca en rojo', (dir) => {
    // Amarillo es honesto acá: sin placa no se puede confirmar el número exacto
    // y la asesora igual está al teléfono. Lo que NO puede pasar es rojo.
    expect(evaluar(dir, 'GT').decision).toBe('yellow');
  });

  it('un país desconocido no rompe: cae al camino colombiano sin explotar', () => {
    expect(() => heuristicValidate('12 calle 3-45 zona 1', 'XX')).not.toThrow();
    expect(evaluar('12 calle 3-45 zona 1', 'XX').decision).toBe('green');
  });
});

describe('heuristicValidate — lo que SÍ tiene que seguir cayendo en rojo', () => {
  // El contrapeso: si el archivo solo probara que nada es rojo, se pasaría
  // haciendo que la heurística devuelva 100 siempre.
  it.each(['CO', 'EC', 'GT'])('basura sin nada útil es roja en %s', (pais) => {
    expect(evaluar('asdasd', pais).decision).toBe('red');
  });

  it.each(['CO', 'EC', 'GT'])('vacío es rojo en %s', (pais) => {
    expect(evaluar('', pais).decision).toBe('red');
  });

  it('caracteres repetidos se penalizan', () => {
    const r = heuristicValidate('Calle 50 # 23-45 aaaaaaaaaa', 'CO');
    expect(r.issues).toContain('repeated_chars');
  });
});

describe('heuristicValidate — retiro en oficina manda sobre el país', () => {
  it.each(['CO', 'EC', 'GT'])('«lo recojo en oficina» es verde en %s', (pais) => {
    const r = heuristicValidate('Reclamo en oficina de Interrapidisimo', pais);
    expect(r.decision).toBe('green');
    expect(r.address_kind).toBe('pickup_office');
  });
});
