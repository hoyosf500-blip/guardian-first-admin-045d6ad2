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
  /**
   * Gestiones FUERA del horario configurado (antes de la primera hora o
   * después de la última). Se cuentan en `total` y se muestran aparte.
   * ⛔ Antes se descartaban (4-sep-2026): con horario 9-17, la que entró a las
   * 7:30 a limpiar el backlog tenía sus 40 gestiones borradas del total y
   * todas sus celdas en rojo — mientras la tarjeta de al lado sí las contaba.
   * Dos cifras contradictorias en la misma pantalla, y la de arriba acusaba.
   */
  fueraDeHorario: number | null;
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
    const horasOp = porOperador.get(operatorId) ?? [];
    const serie = serieHoraria(repartirPorHora(horasOp), desde, hasta);
    const porHora = new Map(serie.map((s) => [s.hora, s.cantidad]));
    // Lo que quedó afuera de `[desde, hasta]` no se pierde: se cuenta aparte
    // y suma al total del día.
    const fuera = horasOp.filter((h) => h < desde || h > hasta).length;

    let total = fuera;
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
      fueraDeHorario: medible ? fuera : null,
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

/**
 * El rótulo de la columna: "16-17", no "16".
 *
 * ⛔ Con el horario 8:00-17:00 la última columna decía «16» y el dueño leyó
 * que el mapa "se cortaba a las 4" (4-sep-2026). No se cortaba: la celda 16
 * cubre de 16:00 a 16:59, o sea hasta las 5. Pero un número solo no dice eso
 * — el rango sí, y es la misma vara que `rangoHora` usa en el detalle.
 */
export function etiquetaColumna(hora: number): string {
  return `${hora}-${hora + 1}`;
}

// ── Una gestión, una vez ─────────────────────────────────────────────────────

export type FuenteGestion = 'confirmar' | 'gestion' | 'bitacora';

/** Una gestión tal como sale de la base, antes de contarla. */
export interface GestionCruda {
  operatorId: string;
  phone: string;
  /** Epoch ms de cuándo actuó la persona. */
  ms: number;
  fuente: FuenteGestion;
  accion: string;
}

/** Los sellos que `markResult` deja en `touchpoints` junto a cada fila de
 *  `order_results`. Son la MISMA marca vista desde dos tablas. */
const SELLO_CONFIRMAR = /^(Confirmado|No respondió|Cancelado:)/;

/** Cuánto pueden distar la fila de `order_results` y su sello para seguir
 *  siendo la misma marca. Se escriben una detrás de la otra (segundos); dos
 *  minutos cubren una red lenta sin pegar dos marcas distintas del mismo
 *  cliente, que la propia cola separa por un cooldown más largo. */
export const VENTANA_ESPEJO_MS = 120_000;

const ultimos9 = (phone: string): string => phone.replace(/\D/g, '').slice(-9);

/**
 * Quita el sello espejo de Confirmar para que cada marca cuente UNA vez.
 *
 * ⛔ Medido en producción el 4-sep-2026 (Ecuador, día anterior): una asesora
 * con 468 marcas en Confirmar salía con **730** en el mapa. Cada «Confirmado»,
 * «No respondió» y «Cancelado: …» escribe una fila en `order_results` Y un
 * sello en `touchpoints` (`markResult`), y el mapa sumaba las dos. Sobre ese
 * número el dueño compara personas y ritmos: inflado a casi el doble, la de
 * Confirmar siempre "rendía más" que la de Seguimiento.
 *
 * Se descarta el sello SOLO si existe la fila de `order_results` de la misma
 * persona, el mismo teléfono y a menos de {@link VENTANA_ESPEJO_MS}. Un sello
 * sin su resultado (la fila de `order_results` falló o se deshizo) se queda:
 * es la única prueba de esa marca.
 */
export function quitarSellosEspejo<T extends GestionCruda>(gestiones: T[]): T[] {
  const resultados = new Map<string, number[]>();
  for (const g of gestiones) {
    if (g.fuente !== 'confirmar') continue;
    const k = `${g.operatorId}|${ultimos9(g.phone)}`;
    const arr = resultados.get(k);
    if (arr) arr.push(g.ms); else resultados.set(k, [g.ms]);
  }
  if (resultados.size === 0) return gestiones;
  return gestiones.filter((g) => {
    if (g.fuente !== 'gestion' || !SELLO_CONFIRMAR.test(g.accion)) return true;
    const cerca = resultados.get(`${g.operatorId}|${ultimos9(g.phone)}`);
    if (!cerca) return true;
    return !cerca.some((ms) => Math.abs(ms - g.ms) <= VENTANA_ESPEJO_MS);
  });
}

/**
 * Qué eventos de la bitácora (`order_events`) cuentan como gestión en el mapa.
 *
 * Solo los que NO tienen espejo en otra tabla: `gestiono`/`llamo`/`escribio`
 * acompañan a un `touchpoints` (`useRecordGestion`) y `marco` a un
 * `order_results` (`markResult`) — contarlos sería el mismo doble de arriba.
 * `abrio`/`cerro`/`salto` son mirar, no hacer. Quedan editar el pedido y leer
 * la conversación, que son trabajo real que hasta hoy no aparecía en el mapa
 * (pedido del dueño, 4-sep-2026: *"que registre todo: inbox, seguimiento,
 * novedades, confirmación"*).
 */
export const EVENTOS_BITACORA_QUE_CUENTAN: ReadonlySet<string> = new Set(['edito', 'leyo_chat']);

export const NOMBRE_EVENTO_MAPA: Record<string, string> = {
  edito: 'Editó el pedido',
  leyo_chat: 'Leyó la conversación',
};
