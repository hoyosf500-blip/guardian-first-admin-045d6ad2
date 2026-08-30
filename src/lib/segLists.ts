import type { OrderData } from './orderUtils';
import { calcBusinessDays, parseDate, diasCalendarioBogota } from './orderUtils';
import { classifySegEstado } from './segStatus';
import { estaDetenido, horasSinMovimiento } from './segPulso';

/**
 * El protocolo de la agencia, en horas.
 *
 * La transportadora retiene el paquete unos SIETE días y después lo devuelve
 * sin avisar; el flete de ida y el de vuelta se pagan igual. Medido en julio-EC:
 * 76 devoluciones así, $2.316.
 *
 * Los dos umbrales parten la espera en dos tramos disjuntos: a las 48 h se
 * avisa, a las 120 h se llama (quedan dos días). Estaban escritos en el texto
 * de la lista desde agosto y no existían en el código — había un solo corte de
 * 48 h, así que el paquete de seis días se veía igual que el de dos.
 */
export const HORAS_AGENCIA_AVISO = 48;
export const HORAS_AGENCIA_LLAMADA = 120;

/**
 * "Listas SLA" estilo Boostec, ORGANIZADAS POR EMBUDO DE PRIORIDAD.
 *
 * Filosofía: el operador necesita atender PRIMERO los pedidos más cerca de
 * entregarse (oficina, reparto, novedad-cliente) porque ahí está el dinero;
 * después los del medio (tránsito) y por último los iniciales (guía generada,
 * pendientes de guía). Esto reemplaza el orden viejo "solo por SLA vencido",
 * que dejaba países con operación reciente (EC) con TODO en "otros estados"
 * porque ningún pedido había cruzado los umbrales de días.
 *
 * Orden de las listas (= prioridad visual + ranking del "sugerido"):
 *  1. Pendientes de confirmación (link a /confirmar) — pre-embudo
 *  2. En oficina        | FINAL — cliente va a recoger
 *  3. En reparto/novedad| FINAL — en mano del repartidor o intento fallido
 *  4. En tránsito       | MEDIO
 *  5. Guía generada     | INICIO post-confirmación
 *  6. Indem. guía generada (+5d) | sub-lista crítica disjoint de la anterior
 *  7. Pendientes de guía         | INICIO — sin guía aún
 *  8. Indem. pendientes de guía (+4d) | sub-lista crítica disjoint
 *  9. Otros estados     | catch-all
 *
 * Reglas de diseño:
 *  - Las listas de FASE matchean por ESTADO solamente (sin umbral de SLA),
 *    para que pedidos recientes también aparezcan en su fase. Antes
 *    `pendientes_guia_2d` y `guia_generada_2d` exigían >= 2d → países con
 *    pedidos < 2d quedaban sin lista de fase visible.
 *  - Las listas con prefijo "indem_" son sub-conjuntos críticos (excedieron
 *    SLA de indemnización). La lista de fase correspondiente se acota con
 *    `< N días` para NO duplicar (un pedido con 5d sin guía cae SOLO en
 *    indem, no en pendientes_guia).
 *  - "pendientes_confirmacion" vive en /confirmar — no se filtra acá, es
 *    sólo un link visual.
 *  - "otros_estados" es el catch-all.
 *  - Los estados TERMINALES (entregado / devuelto / cancelado / borrado, con sus
 *    variantes de EC y por transportadora) no caen en NINGUNA lista: el guard es
 *    global, no del catch-all — ver `esTerminal` y el wrap de SEG_LISTS.
 */

export type SegListSlug =
  | 'pendientes_confirmacion_2d'
  | 'detenidos_3d'
  | 'agencia_2d'
  | 'agencia_5d'
  | 'devolucion_reciente'
  | 'en_oficina'
  | 'en_reparto_novedad'
  | 'en_transito'
  | 'guia_generada'
  | 'indem_guia_generada_5d'
  | 'pendientes_guia'
  | 'indem_pendientes_guia_4d'
  | 'otros_estados';

export interface SegListDef {
  slug: SegListSlug;
  label: string;
  /** SLA en días hábiles para mostrar en el badge / hint (0 = no aplica) */
  slaDias: number;
  /** Tono visual de la lista (urgencia) */
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** Predicado que indica si una orden cae en esta lista */
  matches: (o: OrderData) => boolean;
  /** Link externo si la lista vive en otra ruta (ej. confirmación → /confirmar) */
  externalRoute?: string;
  /**
   * Qué pedidos caen acá, en una frase, para quien nunca usó la pantalla.
   *
   * Va PEGADO al predicado a propósito: una página de ayuda escrita aparte se
   * desincroniza en semanas y termina enseñando algo que el sistema ya no hace.
   * Acá, quien cambia el `matches` tiene la explicación delante de los ojos.
   * La consume `/como-se-trabaja`.
   */
  queEs?: string;
  /** El protocolo de la lista: qué se hace, concretamente. */
  queHacer?: string;
}

/**
 * Normaliza el estado antes de compararlo: mayúsculas, `_`→espacio, espacios
 * colapsados y SIN ACENTOS. Lo último no es cosmético: Ecuador manda
 * "EN TRÁNSITO" con tilde, así que un match exacto contra 'EN TRANSITO' fallaba
 * y el pedido terminaba en "Otros estados". Mismo criterio que
 * `normalizeEstado` + `stripAccents` de estadoBuckets.
 */
const E = (s: string | null | undefined): string =>
  (s || '')
    .toUpperCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * ⚠️ UN SOLO CLASIFICADOR PARA TODA LA PANTALLA.
 *
 * Estas listas tenían su propia copia de los matchers (`ESTADOS_TRANSITO_EXACT`,
 * `ESTADOS_OFICINA`, …), paralela a la de `segStatus.ts` que usa el Tablero. Las
 * dos copias se desincronizaron y el 31-jul-2026 se vio en producción: el mismo
 * pedido en ZONA DE ENTREGA aparecía en "En tránsito" según la Lista (91) y en
 * "En Reparto" según el Tablero (36), y 46 pedidos seguían amontonados en
 * "Otros estados" aunque el Tablero ya sabía qué eran. El dueño lo dijo
 * derecho: "quiero saber todos los estatus de todos mis pedidos, ¿qué es otro?".
 *
 * Ahora la fase la decide SIEMPRE `classifySegEstado`. Agregar un estado nuevo
 * de Dropi se hace en UN solo archivo y las dos vistas se enteran juntas.
 */
const faseDe = (o: OrderData) => classifySegEstado(E(o.estado));

const sinGuia = (o: OrderData): boolean => !(o.guia && o.guia.trim());

const ESTADOS_TERMINALES_EXACT = new Set([
  'ENTREGADO',
  'ENTREGADO A DESTINO', // EC
  'REEMPLAZADA', // Dropi soft-borra la orden vieja al editarla (create-with-edit + PUT)
  'INDEMNIZADA',
  // Pedido BORRADO en Dropi (lo escribe dropi-nightly-reconcile, CON ESPACIO —
  // así se guarda en la DB; la variante con guion bajo llega normalizada a
  // espacio por E()). NO es trabajo: sin esto caía en "otros_estados" y la
  // operadora llamaba a clientes de pedidos que Dropi borró hace semanas.
  'ARCHIVADO GHOST',
]);

// Terminales por CONTENIDO: espejo del filtro del server (NOT LIKE '%CANCEL%')
// y del fallback de estadoBuckets. El match exacto se quedaba corto con las
// variantes que Dropi inventa por transportadora ('CANCELADO POR TRANSPORTADORA',
// 'DEVOLUCION A ORIGEN' de EC): pasaban el catch-all y quedaban clavadas para
// siempre en la cola inflando el denominador "Gestionados X de N".
const TERMINALES_PATTERNS = ['CANCEL', 'DEVOLUC', 'DEVUELT', 'RECHAZ'];

/** ¿El pedido ya murió (entregado / devuelto / cancelado / borrado)? */
const esTerminal = (e: string): boolean => {
  if (!e) return false;
  if (ESTADOS_TERMINALES_EXACT.has(e)) return true;
  return TERMINALES_PATTERNS.some((p) => e.includes(p));
};

/**
 * Días hábiles desde la creación del pedido. Si la fecha es inválida o falta,
 * cae al campo `dias` (calendario) que ya viene en la fila como fallback —
 * esto evita que un pedido con fecha mal parseada quede invisible al filtro.
 */
function diasDesdeCreacion(o: OrderData): number {
  try {
    if (o.fecha) {
      const d = calcBusinessDays(o.fecha);
      if (d > 0) return d;
    }
  } catch {
    // ignore — caemos al fallback
  }
  return Math.max(0, o.dias || 0);
}

/**
 * Días hábiles desde el ÚLTIMO MOVIMIENTO real del pedido en Dropi
 * (`o.lastMovementAt` = updated_at). Para los buckets donde "sin movimiento" es
 * la semántica correcta (guía generada): un pedido VIEJO pero que se movió ayer
 * NO debe contar como atrasado.
 *
 * 0 es un valor VÁLIDO (se movió hoy) — por eso NO usamos el patrón
 * `if (d > 0)` de diasDesdeCreacion. Solo caemos al fallback de creación si
 * `lastMovementAt` falta o no parsea.
 */
function diasSinMovimiento(o: OrderData): number {
  if (o.lastMovementAt && parseDate(o.lastMovementAt)) {
    return calcBusinessDays(o.lastMovementAt);
  }
  return diasDesdeCreacion(o);
}

/**
 * Listas que NO se dibujan como chip porque el Tablero ya las muestra.
 *
 * El dueño lo marcó con un círculo rojo sobre la pantalla: "En tránsito 72" en
 * el chip y "72 EN TRÁNSITO" en la columna, veinte centímetros más abajo. Lo
 * mismo con "En oficina 35". Son filtros de fase pura, y para eso la columna ya
 * tiene su botón de enfocar, que además deja recorrerla de a un pedido.
 *
 * La definición NO se borra: `ACTIONABLE_SEG_SLUGS` las usa para decidir si hay
 * trabajo pendiente en Seguimiento (guard de inactividad). Borrarlas haría creer
 * al sistema que no hay nada que hacer mientras 35 clientes esperan en una
 * oficina. Lo que se quita es el CHIP, no la lógica.
 *
 * Lo que queda a la vista es lo que el Tablero NO puede decir: qué está VENCIDO.
 */
const ESPEJAN_EL_TABLERO: ReadonlySet<string> = new Set([
  'en_oficina',          // = columna "En Oficina"
  'en_transito',         // = columna "En Tránsito"
  'en_reparto_novedad',  // = columnas "En Reparto" + "Novedad" + "Nov. Solucionada"
  'guia_generada',       // = columna "Guía Generada" menos su indem
  'pendientes_guia',     // = columna "En Procesamiento" menos su indem
  'otros_estados',       // = las columnas de estados sin mapear, que ya salen con su nombre
]);

/** ¿Esta lista merece un chip propio, o el Tablero ya la está diciendo? */
export function seMuestraComoChip(l: { slug: string }): boolean {
  return !ESPEJAN_EL_TABLERO.has(l.slug);
}

const SEG_LIST_DEFS: SegListDef[] = [
  // ── Pre-embudo ──────────────────────────────────────────────────────────
  {
    slug: 'pendientes_confirmacion_2d',
    label: 'Pendientes de confirmación (+2 días)',
    queEs: 'Pedidos que entraron hace más de dos días y todavía nadie confirmó. Viven en la pantalla de Confirmar; el chip es solo el atajo.',
    queHacer: 'Se llaman antes del cuarto día: a los cuatro días Dropi los cancela solo. Si no contesta, se marca «No contestó» para que vuelvan a la cola.',
    slaDias: 2,
    tone: 'warning',
    externalRoute: '/confirmar',
    matches: () => false, // vive en /confirmar — esta lista solo es link
  },

  // ── LO QUE SE ESTÁ PUDRIENDO ────────────────────────────────────────────
  // Única lista que NO mira la fase sino el RELOJ: agarra el pedido quieto sin
  // importar en qué columna esté. Por eso no la puede decir el Tablero, que
  // está organizado justamente por fase — un detenido en Reparto y otro en
  // Oficina viven en columnas distintas y nadie los ve juntos.
  // Los terminales quedan fuera (`estaDetenido` lo resuelve): un cancelado
  // quieto hace diez días no está trabado, está terminado.
  {
    slug: 'detenidos_3d',
    label: 'Detenidos (+3 días sin moverse)',
    queEs: 'Cualquier pedido que lleva más de 72 horas sin moverse, sin importar en qué columna esté. Es la única lista que mira el RELOJ y no la fase.',
    queHacer: 'Se le reclama a la TRANSPORTADORA con la guía. Al cliente no se lo llama: no puede hacer nada con esa información y aumenta la cancelación.',
    slaDias: 3,
    tone: 'danger',
    matches: (o) => estaDetenido(o),
  },

  // ── LA PLATA MÁS FÁCIL DE PERDER ────────────────────────────────────────
  // Paquete esperando al CLIENTE en oficina/agencia hace 2+ días. La
  // transportadora lo retiene ~7 días y lo devuelve: en julio-EC fueron 76
  // devoluciones ($2.316), con clientes yendo a retirar cuando el paquete ya
  // iba de regreso (auditoría 14-ago-2026). Segunda lista de RELOJ, con la
  // misma razón de ser que detenidos_3d: la columna "En Oficina" muestra
  // TODOS; este chip muestra los VENCIDOS, que el Tablero no puede decir.
  // Protocolo: día 2 = recordatorio con dirección + guía; día 5 = llamada.
  {
    slug: 'agencia_2d',
    label: 'En agencia sin retirar (+2 días)',
    queEs: 'El paquete llegó a la agencia y el cliente no fue a retirarlo hace dos días o más. La transportadora lo guarda unos siete días y después lo devuelve.',
    queHacer: 'Día 2: aviso al cliente con dirección de la agencia y número de guía. Día 5: llamada. Es la pérdida más cara medida: 76 devoluciones en un mes en Ecuador.',
    slaDias: 2,
    tone: 'warning',
    matches: (o) => {
      if (faseDe(o) !== 'oficina') return false;
      // Reloj real (con hora), no días calendario: mismo criterio que
      // estaDetenido. Sin fecha de movimiento NO matchea — no saber cuándo
      // llegó a la oficina no es lo mismo que saber que está vencido.
      const h = horasSinMovimiento(o);
      return h != null && h >= HORAS_AGENCIA_AVISO && h < HORAS_AGENCIA_LLAMADA;
    },
  },
  {
    // El segundo tramo del MISMO protocolo, que hasta ahora estaba escrito en
    // la pantalla y no existía en el código: `agencia_2d` decía "Día 2: aviso.
    // Día 5: llamada" pero tenía un solo umbral de 48 h, así que el paquete
    // que llevaba seis días esperando se veía igual que el que llevaba dos.
    //
    // Los dos tramos son DISJUNTOS (2d corta en 120 h) para que un paquete
    // esté en uno o en el otro, nunca en los dos: si se sumaran los chips, el
    // mismo paquete se contaría dos veces y la cola del día mentiría.
    slug: 'agencia_5d',
    label: 'En agencia · se devuelve pronto (+5 días)',
    queEs: 'El paquete lleva cinco días o más esperando en la agencia. La transportadora lo guarda unos siete: a este le quedan dos días antes de que salga de vuelta.',
    queHacer: 'Llamalo, no le escribas. Ya se le avisó y no fue. Si no lo retira, el flete de ida y el de vuelta se pagan igual y la venta se pierde entera.',
    slaDias: 5,
    tone: 'danger',
    matches: (o) => {
      if (faseDe(o) !== 'oficina') return false;
      const h = horasSinMovimiento(o);
      return h != null && h >= HORAS_AGENCIA_LLAMADA;
    },
  },

  // ── SE FUE A DEVOLUCIÓN ─────────────────────────────────────────────────
  // Tercera lista de RELOJ, nacida de la queja "Dropi o Guardian no reportan
  // las devoluciones" (auditoría 14-ago-2026, artifact fa210631): la base SÍ
  // las tenía — la pantalla las escondía. Cuando un pedido pasaba a devolución
  // su tarjeta desaparecía en silencio, idéntico a un entregado. Este chip
  // junta las de los últimos 30 días (misma ventana que la carga acotada de
  // useDataLoader) para la llamada de RECUPERACIÓN: en julio-EC, 49 pedidos
  // cancelados se re-emitieron y 32 terminaron entregados — esa plata se
  // rescata llamando UNA vez (el cierre "Devolución" lo saca 30 días).
  //
  // Trabaja sobre estados TERMINALES a propósito: está eximida del guard
  // global (LISTAS_DE_TERMINALES) y NO es accionable — no infla la cola de
  // hoy, porque la cadencia correcta es una llamada de rescate, no una diaria.
  {
    slug: 'devolucion_reciente',
    label: 'Se fue a devolución (últimos 30 días)',
    queEs: 'Pedidos que se fueron de vuelta en los últimos 30 días. No son trabajo diario: es una oportunidad de recuperar la venta.',
    queHacer: 'Se llama UNA vez para saber qué pasó. Si el cliente todavía lo quiere, se vuelve a emitir. De 49 re-emitidos en julio, 32 terminaron entregados.',
    slaDias: 0,
    tone: 'danger',
    matches: (o) => {
      const f = faseDe(o);
      if (f !== 'devolucion' && f !== 'devolucion_transito') return false;
      // Reloj real con hora (mismo criterio que estaDetenido / agencia_2d).
      const h = horasSinMovimiento(o);
      if (h != null) return h <= 30 * 24;
      // ⛔ SIN `last_movement_at` SE CAE A LA FECHA DE CREACIÓN (30-ago-2026).
      //
      // Antes esto devolvía `false`, aplicando la regla "no saber ≠ vencido"
      // —correcta en `agencia_2d` y `detenidos_3d`, donde el reloj DECIDE la
      // urgencia—. Acá el reloj solo acota una ventana, y el LOADER ya resolvió
      // el caso: `useDataLoader` trae explícitamente las devoluciones sin fecha
      // de movimiento creadas en los últimos 90 días, con el comentario de que
      // descartarlas era peor ("no aparecía en Seguimiento NI UN DÍA").
      //
      // O sea: el loader y el predicado se arreglaron por separado con criterios
      // OPUESTOS. El resultado era que esas devoluciones se veían en la columna
      // del tablero pero nunca entraban a la cola de rescate — y el rescate es
      // la llamada que en julio recuperó 32 de 49 pedidos.
      //
      // ⚠️ Días CALENDARIO, no hábiles: la etiqueta de la lista dice "últimos 30
      // días" y `diasDesdeCreacion` cuenta HÁBILES (30 hábiles ≈ 42 corridos).
      // La ventana del reloj de arriba también es calendario (30 × 24 h).
      const diasCal = o.fecha ? diasCalendarioBogota(o.fecha) : Math.max(0, o.dias || 0);
      return diasCal <= 30;
    },
  },

  // ── FASE FINAL (alta prioridad — pedido a punto de entregarse) ──────────
  {
    slug: 'en_oficina',
    label: 'En oficina (cliente recoge)',
    queEs: 'Todos los que están en oficina o agencia esperando que el cliente pase, recién llegados incluidos.',
    queHacer: 'Se vigila. Los que ya llevan dos días esperando son los que urgen, y esos tienen su propia lista («En agencia sin retirar»).',
    slaDias: 0,
    tone: 'warning',
    matches: (o) => faseDe(o) === 'oficina',
  },
  {
    slug: 'en_reparto_novedad',
    label: 'En reparto / Novedad cliente',
    queEs: 'El repartidor los tiene hoy, o el cliente puso una novedad en la entrega.',
    queHacer: 'El reparto se resuelve solo o vuelve como novedad. Lo que sí se trabaja son las novedades, en su propia pantalla.',
    slaDias: 0,
    tone: 'warning',
    // 'reparto' incluye los estados EC de última milla (ZONA DE ENTREGA, EN
    // DISTRIBUCION A CLIENTE): el paquete va camino a la puerta del cliente y
    // hay que avisarle para que tenga el efectivo. Antes se monitoreaban como
    // tránsito, o sea que 56 pedidos calientes no contaban como trabajo.
    matches: (o) => ['reparto', 'novedad', 'novedad_sol'].includes(faseDe(o)),
  },

  // ── FASE MEDIA ──────────────────────────────────────────────────────────
  {
    slug: 'en_transito',
    label: 'En tránsito',
    queEs: 'Van camino al cliente y avanzan solos.',
    queHacer: 'No se gestionan: se vigilan. Llamar acá no acelera nada. Si se quedan quietos aparecen en «Detenidos».',
    slaDias: 7,
    tone: 'info',
    matches: (o) => faseDe(o) === 'transito',
  },

  // ── FASE INICIAL — guía generada ────────────────────────────────────────
  // 'bodega_trans' (ADMITIDA / EN BODEGA TRANSPORTADORA) va acá y no en
  // tránsito: la guía existe pero el paquete no se movió, que es exactamente
  // lo que mide el reloj de indemnización.
  {
    slug: 'guia_generada',
    label: 'Guía generada',
    queEs: 'Ya tienen guía pero la transportadora todavía no los recogió.',
    queHacer: 'Se vigila. Si pasan días sin moverse dejan de ser espera y pasan a «Detenidos» o a la lista de indemnización.',
    slaDias: 5,
    tone: 'info',
    matches: (o) => {
      if (!['guia', 'bodega_trans'].includes(faseDe(o))) return false;
      // Disjoint con indem (>= 5d). Pedido nuevo o reciente cae acá.
      return diasSinMovimiento(o) < 5;
    },
  },
  {
    slug: 'indem_guia_generada_5d',
    label: 'Indem. guía generada (+5 días)',
    queEs: 'Llevan más de cinco días con la guía generada y sin que nadie los recoja. A esta altura ya se puede reclamar.',
    queHacer: 'Se reclama la indemnización a la transportadora. Es plata que se pierde por no pedirla a tiempo.',
    slaDias: 5,
    tone: 'danger',
    matches: (o) => {
      if (!['guia', 'bodega_trans'].includes(faseDe(o))) return false;
      return diasSinMovimiento(o) >= 5;
    },
  },

  // ── FASE INICIAL — sin guía aún ─────────────────────────────────────────
  {
    slug: 'pendientes_guia',
    label: 'Pendientes de guía',
    queEs: 'Confirmados, pero todavía sin guía generada.',
    queHacer: 'Se vigila unos días. Si se pasan de cuatro, aparecen en la lista de indemnización de pendientes.',
    slaDias: 4,
    tone: 'info',
    matches: (o) => {
      if (faseDe(o) !== 'procesamiento' || !sinGuia(o)) return false;
      // Disjoint con indem (>= 4d). Recientes caen acá.
      return diasDesdeCreacion(o) < 4;
    },
  },
  {
    slug: 'indem_pendientes_guia_4d',
    label: 'Indem. pendientes de guía (+4 días)',
    queEs: 'Llevan más de cuatro días confirmados y sin guía.',
    queHacer: 'Se reclama. El pedido está parado antes de salir y el cliente ya está esperando.',
    slaDias: 4,
    tone: 'danger',
    matches: (o) => {
      if (faseDe(o) !== 'procesamiento' || !sinGuia(o)) return false;
      return diasDesdeCreacion(o) >= 4;
    },
  },

  // ── Catch-all ───────────────────────────────────────────────────────────
  // Con el clasificador unificado esta lista queda casi vacía a propósito: si
  // vuelve a crecer es que Dropi inventó un estado nuevo y hay que mapearlo en
  // segStatus.ts (el Tablero lo muestra con nombre y volumen).
  {
    slug: 'otros_estados',
    label: 'Otros estados',
    queEs: 'Estados que Guardian todavía no sabe clasificar — normalmente variantes nuevas que inventó Dropi.',
    queHacer: 'Se miran de vez en cuando. Si aparece una variante repetida, se avisa para agregarla al mapa de estados.',
    slaDias: 0,
    tone: 'neutral',
    matches: (o) => {
      const e = E(o.estado);
      if (!e) return false;
      // Los terminales los corta el guard global (ver SEG_LISTS más abajo).
      if (e === 'PENDIENTE CONFIRMACION') return false;
      const fase = faseDe(o);
      if (fase === 'otros') return true;
      // Pre-guía CON guía: ya no es "pendiente de guía" pero tampoco sabemos en
      // qué fase va. Cae acá para seguir VISIBLE — antes no matcheaba ninguna
      // lista y el pedido desaparecía de Seguimiento sin que nadie lo notara.
      return fase === 'procesamiento' && !sinGuia(o);
    },
  },
];

/**
 * Listas que trabajan sobre estados TERMINALES a propósito (devoluciones): el
 * guard global de abajo las dejaría vacías para siempre — su patrón 'DEVOLUC'
 * es exactamente lo que estas listas buscan. Su predicado acota solo
 * (fase de devolución + reloj de 30 días).
 */
const LISTAS_DE_TERMINALES: ReadonlySet<string> = new Set(['devolucion_reciente']);

/**
 * Guard TERMINAL aplicado a TODAS las listas, no solo al catch-all: las
 * variantes de Ecuador ('ENTREGADO A DESTINO', 'DEVOLUCION A ORIGEN') matcheaban
 * predicados de fase y, como el estado ya no vuelve a cambiar, el pedido quedaba
 * clavado en la cola — la asesora llamaba a clientes que ya tenían el paquete.
 * (Excepción explícita: LISTAS_DE_TERMINALES, cuyo trabajo ES el terminal.)
 */
export const SEG_LISTS: SegListDef[] = SEG_LIST_DEFS.map((l) => (
  LISTAS_DE_TERMINALES.has(l.slug)
    ? l
    : { ...l, matches: (o: OrderData) => !esTerminal(E(o.estado)) && l.matches(o) }
));

export function findSegList(slug: SegListSlug): SegListDef | undefined {
  return SEG_LISTS.find((l) => l.slug === slug);
}

export function isValidSegListSlug(s: string | null | undefined): s is SegListSlug {
  if (!s) return false;
  return SEG_LISTS.some((l) => l.slug === s);
}

/**
 * Listas de Seguimiento que representan TRABAJO ACCIONABLE — la operadora tiene
 * que llamar/gestionar: cliente en oficina, en reparto/novedad, indemnizaciones
 * vencidas y pendientes de guía. Las de MONITOREO (en tránsito, guía generada
 * reciente, otros estados) NO cuentan como trabajo: solo se observan.
 *
 * Lo usa el guard de inactividad para NO penalizar cuando no hay nada que hacer
 * en Seguimiento (si además Confirmar y Novedades están vacíos).
 */
export const ACTIONABLE_SEG_SLUGS: SegListSlug[] = [
  // Un pedido quieto hace 3+ días es trabajo pendiente por definición: alguien
  // tiene que llamar a la transportadora. Va acá aunque no se dibuje como chip
  // en las mismas condiciones que las otras.
  // `devolucion_reciente` NO va: la llamada de rescate se hace UNA vez, y
  // meterla acá la exigiría todos los días durante 30 días.
  'detenidos_3d',
  'agencia_2d',
  // El tramo de 5 días va acá igual que el de 2: `esAccionable` es una UNIÓN
  // (`.some`), así que un paquete que está en uno no puede estar en el otro y
  // nada se cuenta dos veces. Omitirlo haría que el paquete más urgente —el que
  // se devuelve pasado mañana— desapareciera de la cola del día al cruzar las
  // 120 h, que es exactamente al revés de lo que hace falta.
  'agencia_5d',
  'en_oficina',
  'en_reparto_novedad',
  'indem_guia_generada_5d',
  'indem_pendientes_guia_4d',
  'pendientes_guia',
];

// Pre-computado una sola vez (constantes de módulo) — se llama por render del guard.
const ACTIONABLE_SEG_DEFS = SEG_LISTS.filter((l) => ACTIONABLE_SEG_SLUGS.includes(l.slug));

/**
 * ¿Este pedido está en la COLA DE HOY? (unión de las listas accionables)
 *
 * Es la población que el hero de Seguimiento exige "dejar en 0": lo mismo que
 * el guard de inactividad ya considera trabajo. Un paquete viajando NO entra —
 * se vigila, no se gestiona.
 */
export function esAccionable(o: OrderData): boolean {
  return ACTIONABLE_SEG_DEFS.some((d) => d.matches(o));
}

/** ¿Hay al menos un pedido de Seguimiento en una lista accionable? */
export function hasSeguimientoWork(orders: OrderData[]): boolean {
  return orders.some(esAccionable);
}
