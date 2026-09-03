// src/lib/mapaCalor.ts
//
// EL MAPA DE CALOR DEL TURNO: qué hizo cada asesora, hora por hora.
//
// ── Por qué existe (pedido del dueño, 3-sep-2026) ───────────────────────────
// Textual: *"quiero controlar cada hora: de 8 a 9 qué hicieron, de 10 a 11
// cuánto avanzaron, qué tocaron"*. Y la frase que ordena todo el archivo:
// *"hay asesoras que me dicen 'ya lo toqué', pero **la última palabra la tiene
// Guardian**"*.
//
// ⛔ SI GUARDIAN VA A TENER LA ÚLTIMA PALABRA, NO PUEDE INVENTAR NINGUNA.
// Sobre estas celdas el dueño va a hablar con una persona. Por eso una celda
// vacía NO es un estado: son CUATRO, y confundirlos es la diferencia entre un
// reclamo justo y una acusación falsa.
//
//   · `trabajo`    — se midió y hubo gestiones. El número es real.
//   · `sin_trabajo`— se midió y no hubo NINGUNA. Esto sí se puede reclamar.
//   · `todavia_no` — la hora no llegó. Un cero acá no significa nada.
//   · `sin_medir`  — la lectura falló. No se sabe, y se dice.
//
// Este proyecto ya pagó tres veces por mezclarlos: *"no hubo cancelaciones"*
// sobre un mes con 345, *"todos atendidos"* sobre 39 clientes esperando, y el
// panel que mostraba CERO avisos de inactividad porque solo se grababan al
// apretar «Entendido».
//
// ── La otra trampa, la de la hora ───────────────────────────────────────────
// `orders.created_at` **NO** es cuándo el cliente hizo el pedido: es cuándo el
// cron lo insertó, corrido +5 h de mediana y con cola hasta +120 h
// (`docs/ARQUITECTURA.md`). Ya produjo una conclusión falsa que hubo que
// retractar (*"la franja de la noche cancela 48%"*). Acá las horas vienen del
// `created_at` de la GESTIÓN — cuándo actuó la persona—, que es el único que
// mide lo que se quiere medir.
//
// Puro: sin red, sin React, sin reloj implícito.

import { repartirPorHora, serieHoraria } from './ritmoEnVivo';

export type EstadoCelda = 'trabajo' | 'sin_trabajo' | 'todavia_no' | 'sin_medir';

export interface CeldaMapa {
  /** Hora Bogotá, 0-23. La celda cubre de `hora`:00 a `hora`:59. */
  hora: number;
  /** Gestiones en esa hora. `null` cuando no se puede afirmar nada. */
  cantidad: number | null;
  estado: EstadoCelda;
  /** La hora pisa el almuerzo de la tienda. NO cambia el estado — solo se usa
   *  para el texto, porque reclamar por una hora de almuerzo es injusto y
   *  pintarla entera como almuerzo escondería el trabajo real de su otra mitad
   *  (con 12:30-13:30, la hora 12 tiene media hora de trabajo de verdad). */
  tocaAlmuerzo: boolean;
}

export interface FilaMapa {
  operatorId: string;
  celdas: CeldaMapa[];
  /** Total del día para esa persona. `null` si no se pudo medir. */
  total: number | null;
  /** Horas del horario que pasaron y quedaron en cero. `null` si no se midió.
   *  Es el número que el dueño busca: "estuvo tres horas sin marcar nada". */
  horasEnCero: number | null;
}

export interface MapaCalor {
  /** Las horas que se dibujan, del horario de la tienda. */
  horas: number[];
  filas: FilaMapa[];
  /** La celda más alta, para escalar la intensidad. 0 si no hay nada. */
  maximo: number;
  /** false = la lectura falló; todas las celdas van en `sin_medir`. */
  medible: boolean;
}

export interface MarcaHoraria {
  operatorId: string;
  /** Hora Bogotá (0-23) en que la persona actuó. */
  hora: number;
}

export interface MapaCalorInput {
  marcas: MarcaHoraria[];
  /** Todas las que trabajan, aunque no tengan ni una marca: una fila entera en
   *  cero es justamente el dato que se busca. Si salieran solo las que
   *  aparecen en `marcas`, la que no hizo NADA desaparecería del mapa. */
  operadores: string[];
  /** Horario de la tienda en minutos del día (de `useStoreSchedule`). */
  horario: {
    work_start_min: number;
    work_end_min: number;
    lunch_start_min: number;
    lunch_end_min: number;
  };
  /** false = la lectura de gestiones falló. Todo va en `sin_medir`. */
  medible: boolean;
  /**
   * Hora Bogotá actual, SOLO si el mapa es del día de hoy. Las horas que
   * todavía no pasaron salen `todavia_no` en vez de `sin_trabajo`.
   *
   * ⛔ Sin esto, a las 9 de la mañana el mapa acusaría a todo el equipo de no
   * haber trabajado de 10 a 17. `null`/ausente = día cerrado, todas las horas
   * del horario ya pasaron.
   */
  horaActual?: number | null;
}

/** Las horas que cubre el horario. 9:00-17:00 ⇒ [9..16] (la hora 16 es 16:00-16:59). */
export function horasDelHorario(workStartMin: number, workEndMin: number): number[] {
  const desde = Math.max(0, Math.min(23, Math.floor(workStartMin / 60)));
  // `ceil - 1`: un cierre a las 17:00 no agrega una columna "17" vacía; uno a
  // las 17:30 sí, porque en esa media hora se trabaja.
  const hasta = Math.max(desde, Math.min(23, Math.ceil(workEndMin / 60) - 1));
  const out: number[] = [];
  for (let h = desde; h <= hasta; h++) out.push(h);
  return out;
}

/** ¿La hora pisa el almuerzo? Basta que se solapen, no que lo contenga. */
function pisaAlmuerzo(hora: number, lunchStart: number, lunchEnd: number): boolean {
  if (!(lunchEnd > lunchStart)) return false;
  return hora * 60 < lunchEnd && (hora + 1) * 60 > lunchStart;
}

export function construirMapaCalor(input: MapaCalorInput): MapaCalor {
  const { marcas, operadores, horario, medible } = input;
  const horas = horasDelHorario(horario.work_start_min, horario.work_end_min);
  const desde = horas[0];
  const hasta = horas[horas.length - 1];

  const porOperador = new Map<string, number[]>();
  for (const op of operadores) porOperador.set(op, []);
  for (const m of marcas) {
    // Una marca de alguien que ya no está en la lista (se fue del equipo) no
    // inventa una fila: el mapa muestra el turno de hoy, no el historial.
    const arr = porOperador.get(m.operatorId);
    if (arr) arr.push(m.hora);
  }

  let maximo = 0;
  const filas: FilaMapa[] = operadores.map((operatorId) => {
    const serie = serieHoraria(repartirPorHora(porOperador.get(operatorId) ?? []), desde, hasta);
    const porHora = new Map(serie.map((s) => [s.hora, s.cantidad]));

    let total = 0;
    let enCero = 0;
    const celdas: CeldaMapa[] = horas.map((hora) => {
      const tocaAlmuerzo = pisaAlmuerzo(hora, horario.lunch_start_min, horario.lunch_end_min);
      if (!medible) return { hora, cantidad: null, estado: 'sin_medir', tocaAlmuerzo };
      // La hora en curso NO se juzga: a las 10:05 la celda de las 10 tiene cinco
      // minutos de vida y un cero ahí no dice nada. Se cuenta pero no acusa.
      if (input.horaActual != null && hora >= input.horaActual) {
        const n = porHora.get(hora) ?? 0;
        total += n;
        if (n > maximo) maximo = n;
        return { hora, cantidad: n, estado: 'todavia_no', tocaAlmuerzo };
      }
      const n = porHora.get(hora) ?? 0;
      total += n;
      if (n > maximo) maximo = n;
      if (n === 0) enCero++;
      return { hora, cantidad: n, estado: n > 0 ? 'trabajo' : 'sin_trabajo', tocaAlmuerzo };
    });

    return {
      operatorId,
      celdas,
      total: medible ? total : null,
      horasEnCero: medible ? enCero : null,
    };
  });

  return { horas, filas, maximo, medible };
}

/** Intensidad 0..1 de una celda, para el color. Las que no se pueden afirmar
 *  devuelven `null` — el que dibuja tiene que elegir otro tratamiento, no un
 *  color de "poco trabajo" que se confunde con un cero medido. */
export function intensidad(celda: CeldaMapa, maximo: number): number | null {
  if (celda.cantidad == null || celda.estado === 'sin_medir') return null;
  if (maximo <= 0) return 0;
  return Math.min(1, celda.cantidad / maximo);
}

/** "9:00 a 10:00". Una hora se nombra por su rango, no por su número: "la hora
 *  9" no se lee, "de 9 a 10" sí — y es como lo pidió el dueño. */
export function rangoHora(hora: number): string {
  return `${hora}:00 a ${hora + 1}:00`;
}
