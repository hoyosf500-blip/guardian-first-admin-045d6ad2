/**
 * Cortacircuitos de la base de datos.
 *
 * ── Por qué existe (5-sep-2026, la mañana en que la base se congeló 20 min) ──
 * A las 14:33:38Z una consulta de UNA fila por clave primaria pasó de 130 ms a
 * 9 s, después 56 s, después **302 s**. `auth/health` y `rest/v1/` medidos con
 * curl, desde fuera de cualquier pestaña, daban timeout a los 30 y 40 s. El
 * proyecto entero de Supabase estaba ahogado — el mismo incidente del 25-ago
 * (REGLA #0 en CLAUDE.md).
 *
 * Lo que la app hacía MIENTRAS TANTO empeoraba todo:
 *  - React Query reintentaba cada consulta caída 3 veces (su default).
 *  - `StoreContext` reintentaba `set_active_store` cada 30 s en cada pestaña.
 *  - 13 polls (`pollWhenVisible`) seguían disparando puntualmente.
 *  - Cada gestión de una asesora seguía disparando, por realtime, 5-20
 *    consultas en CADA pestaña abierta (RPCs de agregación incluidas).
 * Una pestaña quieta en /admin acumuló 195 peticiones en 20 minutos y 174
 * errores. Cinco pestañas así, contra una base que no puede contestar, son la
 * diferencia entre un pico de 30 segundos y un apagón de 20 minutos.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────
 * Observa TODAS las respuestas de Supabase (se engancha en el `fetch` del
 * cliente, ver `integrations/supabase/fetchConFreno.ts`). Si en la última
 * ventana de 60 s hubo 3 o más síntomas —respuesta 5xx, red caída, o más de
 * 8 s de espera— se ABRE durante 45 s, y se sigue extendiendo mientras los
 * síntomas continúen.
 *
 * Mientras está abierto:
 *  - `pollWhenVisible` se salta sus ticks.
 *  - Los refetch disparados por realtime preguntan `abierto()` y esperan.
 *  - React Query no reintenta.
 *  - `FrenoBaseAviso` lo dice en la cabecera, con palabras: la asesora tiene
 *    que saber que la base está lenta y que NO es que Guardian se rompió.
 *
 * ⛔ Lo que NUNCA frena: las acciones de la persona. Marcar un resultado,
 * mandar una plantilla, guardar una nota — todo eso sale igual, lento pero
 * sale. El freno es para lo AUTOMÁTICO, que es lo que multiplica.
 *
 * ⛔ Y nunca se abre por 4xx: un 401/403/404 es un error de la app o del
 * permiso, no de la salud de la base. Contarlo abriría el freno por un bug
 * cualquiera y escondería el bug detrás de «la base está lenta».
 *
 * Puro: sin React, sin red. Testeable.
 */

export interface EstadoFreno {
  abierto: boolean;
  /** Cuándo se abrió (ms epoch). null si está cerrado. */
  desde: number | null;
  /** Hasta cuándo, como mínimo, sigue abierto. Se extiende con cada síntoma. */
  hasta: number | null;
  /** Qué lo abrió, para el aviso y para el log. */
  motivo: string | null;
  /** Síntomas en la ventana actual. */
  sintomas: number;
}

export interface RespuestaObservada {
  /** Cuánto tardó la petición, en ms. */
  ms: number;
  /** HTTP status. Ausente si la petición no llegó a tener respuesta. */
  status?: number;
  /** true si `fetch` rechazó (red caída, abortada, DNS…). */
  fallo?: boolean;
}

/** Ventana en la que se cuentan los síntomas. */
export const VENTANA_MS = 60_000;
/** Una respuesta más lenta que esto es un síntoma aunque haya llegado bien. */
export const LENTA_MS = 8_000;
/** Con esta cantidad de síntomas en la ventana, se abre. */
export const SINTOMAS_PARA_ABRIR = 3;
/** Cuánto queda abierto desde el último síntoma. */
export const ABIERTO_MS = 45_000;

let marcas: number[] = [];
let hasta = 0;
let desde: number | null = null;
let motivo: string | null = null;
let temporizadorCierre: ReturnType<typeof setTimeout> | null = null;
const oyentes = new Set<(e: EstadoFreno) => void>();

/** Inyectable para las pruebas. */
let ahora: () => number = () => Date.now();

function podar(t: number): void {
  marcas = marcas.filter((m) => t - m < VENTANA_MS);
}

function avisar(): void {
  const e = estado();
  for (const cb of oyentes) {
    try { cb(e); } catch (err) { console.warn('[frenoBase] un oyente reventó:', err); }
  }
}

function programarCierre(t: number): void {
  if (temporizadorCierre) clearTimeout(temporizadorCierre);
  temporizadorCierre = setTimeout(() => {
    temporizadorCierre = null;
    // Puede haberse extendido mientras tanto: solo se cierra si de verdad venció.
    if (ahora() >= hasta) {
      desde = null;
      motivo = null;
      console.info('[frenoBase] la base volvió a responder: se reanudan las actualizaciones automáticas');
      avisar();
    } else {
      programarCierre(ahora());
    }
  }, Math.max(50, hasta - t));
}

/** Clasifica una respuesta. Devuelve el motivo si es síntoma, o null. */
export function esSintoma(r: RespuestaObservada): string | null {
  if (r.fallo) return 'la red no respondió';
  if (r.status !== undefined && r.status >= 500) return `la base devolvió ${r.status}`;
  if (r.ms > LENTA_MS) return `una consulta tardó ${Math.round(r.ms / 1000)} s`;
  return null;
}

/**
 * Alimentar con cada respuesta de Supabase. Barato: un push y un filtro sobre
 * una lista que nunca pasa de unas decenas de marcas.
 */
export function registrarRespuesta(r: RespuestaObservada): void {
  const que = esSintoma(r);
  if (!que) return;
  const t = ahora();
  marcas.push(t);
  podar(t);
  if (marcas.length < SINTOMAS_PARA_ABRIR) return;

  const estabaAbierto = t < hasta;
  hasta = t + ABIERTO_MS;
  if (!estabaAbierto) {
    desde = t;
    motivo = que;
    console.warn(`[frenoBase] ABIERTO: ${marcas.length} síntomas en ${VENTANA_MS / 1000} s (último: ${que}). Se pausan polls y refetch automáticos ${ABIERTO_MS / 1000} s.`);
    avisar();
  }
  programarCierre(t);
}

/** ¿Hay que aguantarse la actualización automática? */
export function abierto(): boolean {
  return ahora() < hasta;
}

export function estado(): EstadoFreno {
  const t = ahora();
  podar(t);
  const ab = t < hasta;
  return { abierto: ab, desde: ab ? desde : null, hasta: ab ? hasta : null, motivo: ab ? motivo : null, sintomas: marcas.length };
}

/** Suscribirse a los cambios (abre / cierra). Devuelve la baja. */
export function onCambio(cb: (e: EstadoFreno) => void): () => void {
  oyentes.add(cb);
  return () => { oyentes.delete(cb); };
}

/** Solo para pruebas: vuelve todo a cero y permite fijar el reloj. */
export function _reiniciarParaPruebas(reloj?: () => number): void {
  marcas = [];
  hasta = 0;
  desde = null;
  motivo = null;
  if (temporizadorCierre) { clearTimeout(temporizadorCierre); temporizadorCierre = null; }
  oyentes.clear();
  ahora = reloj ?? (() => Date.now());
}
