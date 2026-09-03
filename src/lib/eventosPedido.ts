/**
 * La bitácora: qué hizo la asesora en pantalla, sobre qué pedido y cuánto tardó.
 *
 * ── Por qué existe (pedido del dueño, 3-sep-2026) ───────────────────────────
 * *"Ayer en Novedades la operadora me dijo que lo había tocado, pero no sé si
 * me miente."*
 *
 * `touchpoints` ya guarda las GESTIONES y con eso se responde "¿lo tocó?". Lo
 * que faltaba es lo otro: **lo que no se hizo**. Abrir una novedad, mirarla y
 * pasar a la siguiente con la flecha no dejaba rastro, así que "no la vio" y
 * "la vio y la saltó" se veían igual. Y son dos conversaciones distintas.
 *
 * ── Las tres reglas de este archivo ─────────────────────────────────────────
 *
 * 1. **El vocabulario vive acá y en ningún otro lado.** `evento` es texto libre
 *    en la base a propósito (agregar uno nuevo no puede costar una migración
 *    sobre una tabla de millones de filas), pero si cada pantalla inventa el
 *    suyo se termina con veinte formas de escribir lo mismo y ninguna consulta
 *    vuelve a servir. El tipo `EventoPedido` es la única lista.
 *
 * 2. **Registrar NUNCA puede romper ni frenar la pantalla.** Todo va por un
 *    lote que se manda solo, en segundo plano, y cualquier error se traga con
 *    un `console.warn`. Una asesora no puede perder una gestión porque la
 *    bitácora tuvo un mal minuto.
 *
 * 3. ⛔ **No es a prueba de balas, y eso se dice.** Si se cierra el navegador
 *    de golpe, el último lote —hasta {@link INTERVALO_MS} de eventos— se
 *    pierde. Se hace lo posible (se vacía cuando la pestaña se oculta, que es
 *    lo que dispara el cierre normal), pero una ausencia en la bitácora NO
 *    prueba que algo no pasó. Prometer lo contrario sería peor que no tenerla:
 *    el dueño tomaría una decisión sobre una persona con un dato que no aguanta.
 */

/** Qué pasó. Uno por acción real; nada de clics que no cambian nada. */
export type EventoPedido =
  /** Se abrió la ficha/tarjeta de un pedido y quedó a la vista. */
  | 'abrio'
  /** Se salió del pedido. Trae `ms_en_pantalla`. */
  | 'cerro'
  /** ⛔ EL QUE FALTABA: se pasó al siguiente SIN gestionar. Trae el tiempo que
   *  lo tuvo a la vista, que es lo que separa "lo revisó y no aplicaba" de
   *  "pasó de largo". */
  | 'salto'
  /** Se registró una gestión (espejo de `touchpoints`, pero CON el pedido). */
  | 'gestiono'
  /** Se llamó por teléfono. */
  | 'llamo'
  /** Salió un WhatsApp, ya verificado contra el chat. */
  | 'escribio'
  /** Se leyó la conversación. */
  | 'leyo_chat'
  /** Se editó el pedido (dirección, valor, transportadora…). */
  | 'edito'
  /** Se marcó un resultado (confirmado, cancelado, novedad resuelta…). */
  | 'marco'
  /** ⛔ Se DESHIZO una marca (4-sep-2026). Antes el "Deshacer" borraba la fila
   *  de `order_results` y la de `touchpoints` y no quedaba rastro en ningún
   *  lado: "confirmó y deshizo" era invisible, y es exactamente la maniobra
   *  para inflar y desinflar un número. Trae en `detalle` qué se deshizo. */
  | 'deshizo';

/** Lo que se guarda en `detalle`. Valores planos a propósito: es una columna
 *  jsonb que se va a leer desde una pantalla y desde SQL, y un objeto anidado
 *  ahí adentro se vuelve ilegible para las dos. */
export type DetalleEvento = Record<string, string | number | boolean | null>;

export interface EventoPendiente {
  store_id: string;
  operator_id: string;
  external_id: string | null;
  phone: string | null;
  evento: EventoPedido;
  detalle: DetalleEvento;
  ms_en_pantalla: number | null;
  /** Cuándo pasó DE VERDAD, no cuándo se mandó el lote. Con un lote de varios
   *  segundos, dejar que la base pusiera `now()` amontonaría en el mismo
   *  instante cosas que ocurrieron separadas — y el orden de los hechos es
   *  justo lo que esta tabla existe para contar. */
  created_at: string;
}

/** Cada cuánto se vacía la cola. Cuatro segundos es el equilibrio entre no
 *  hacer un viaje por clic y no perder mucho si el navegador se cierra. */
export const INTERVALO_MS = 4_000;
/** Con esto en la cola se manda sin esperar al reloj. */
export const TOPE_LOTE = 12;

/**
 * ¿Cuánto estuvo a la vista? `null` cuando no se puede medir.
 *
 * ⛔ Nunca devuelve 0 por no saber. Sin marca de apertura el resultado es
 * `null` = "no se midió", que es un dato distinto de "estuvo cero tiempo" y
 * lleva a una conclusión distinta sobre la persona.
 */
export function msEnPantalla(desdeMs: number | null | undefined, hastaMs: number): number | null {
  if (desdeMs == null || !Number.isFinite(desdeMs)) return null;
  const d = hastaMs - desdeMs;
  if (!Number.isFinite(d) || d < 0) return null;
  return Math.round(d);
}

/**
 * ¿Este paso al siguiente pedido fue un SALTO?
 *
 * Lo es cuando se dejó el pedido sin haber registrado ninguna gestión mientras
 * estuvo abierto. `gestionesEnVivo` es cuántas gestiones se registraron desde
 * que se abrió — si hubo aunque sea una, no fue un salto: fue trabajo.
 */
export function esSalto(gestionesEnVivo: number): boolean {
  return gestionesEnVivo <= 0;
}

/**
 * Un salto muy corto es distinto de uno pensado, y conviene poder separarlos
 * sin volver a mirar los milisegundos en cada consulta.
 *
 * El umbral es DELIBERADAMENTE bajo. Dos segundos no alcanzan para leer la
 * novedad de un cliente; lo que está debajo de eso es pasar de largo. Arriba de
 * eso no se afirma nada: se deja el tiempo y que lo juzgue quien conoce el caso.
 */
export const SALTO_SIN_MIRAR_MS = 2_000;

export function saltoSinMirar(ms: number | null): boolean {
  return ms != null && ms < SALTO_SIN_MIRAR_MS;
}

/** Texto para la pantalla. Que lo lea alguien que no programó esto. */
export const NOMBRE_EVENTO: Record<EventoPedido, string> = {
  abrio: 'Abrió el pedido',
  cerro: 'Salió del pedido',
  salto: 'Pasó al siguiente sin gestionar',
  gestiono: 'Registró una gestión',
  llamo: 'Llamó',
  escribio: 'Mandó un WhatsApp',
  leyo_chat: 'Leyó la conversación',
  edito: 'Editó el pedido',
  marco: 'Marcó un resultado',
  deshizo: 'Deshizo una marca',
};

/** "2 min 14 s", "8 s", "—". Para leer una duración de un vistazo. */
export function duracionLegible(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}
