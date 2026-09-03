// src/lib/presenciaReparto.ts
//
// A QUIÉN SE LE PUEDE ASIGNAR TRABAJO: no al que está conectado, al que ESTÁ
// TRABAJANDO.
//
// ── Por qué existe (pedido del dueño, 3-sep-2026) ───────────────────────────
// Textual: *"si hay 2 o 3 personas pero solo 1 está confirmando bien… que el
// CRM no le vaya a quitar trabajo o a parar pedidos porque detecte que están
// 3 o 4 personas conectadas; **si no hay actividad no le puede asignar**"*.
//
// Hasta hoy el reparto contaba como presente a cualquiera con `first_action_at`
// — o sea, **a quien abrió el CRM en algún momento del día**. Alguien que marcó
// entrada a las 8, se desconectó a las 9 y no volvió seguía recibiendo un
// tercio de la cola a las 3 de la tarde. Ese tercio no lo trabajaba nadie: es
// exactamente medio problema del sistema viejo de auto-asignación (pedidos con
// dueño y sin gestión) que se apagó en mayo-2026.
//
// ⛔ LA DISTINCIÓN QUE SOSTIENE TODO: «no se pudo leer» ≠ «nadie está
// trabajando». Si la lectura falla se reparte entre todas (fallar abierto: no
// repartirle a quien SÍ vino la deja sin trabajo todo el día). Si la lectura
// funcionó y nadie está activo, NO se reparte — y se reintenta en unos minutos.
// Meter esos dos casos en la misma bolsa es lo que hacía el código anterior.
//
// Puro: sin red, sin React, sin reloj implícito.

/**
 * Cuántos minutos sin actividad hacen que alguien deje de recibir trabajo.
 *
 * 30 minutos, y no menos: el guard de inactividad avisa a los 6 y el panel del
 * dueño marca "sin marcar" a los 20. Un umbral corto acá tendría un efecto
 * distinto y peor — quien está en una llamada larga con un cliente difícil
 * dejaría de recibir su parte de la cola justo por estar haciendo bien su
 * trabajo. Media hora separa "está en algo" de "no está".
 *
 * Y no más: con una hora, alguien que se fue a las 2 sigue recibiendo pedidos
 * hasta las 3, que es el problema que esto viene a resolver.
 */
export const MINUTOS_SIN_ACTIVIDAD = 30;

export interface FilaPresencia {
  operator_id?: string | null;
  /** Marca de entrada del día. */
  first_action_at?: string | null;
  /** Última señal de actividad real. */
  last_active_at?: string | null;
}

/**
 * Quiénes pueden recibir trabajo AHORA.
 *
 * `null` significa **no se pudo medir** y el llamador tiene que fallar abierto.
 * Un `Set` vacío significa **nadie está trabajando**, que es una respuesta
 * distinta y se trata distinto.
 */
export function presentesActivos(
  filas: FilaPresencia[] | null | undefined,
  ahoraMs: number,
  minutos: number = MINUTOS_SIN_ACTIVIDAD,
): Set<string> | null {
  if (!Array.isArray(filas)) return null;
  const corte = ahoraMs - minutos * 60_000;
  const s = new Set<string>();
  for (const f of filas) {
    const id = f?.operator_id;
    if (!id) continue;
    // Sin marca de entrada no está en el turno.
    if (!f.first_action_at) continue;
    const ultima = f.last_active_at ? Date.parse(f.last_active_at) : NaN;
    // ⛔ Sin `last_active_at` legible NO se asume que está activa. Antes esta
    // función solo miraba `first_action_at`, y por eso alguien que se fue a
    // media mañana seguía recibiendo cola. Si la columna no viniera, el
    // resultado es un conjunto vacío → el llamador no reparte y reintenta;
    // nunca reparte a ciegas.
    if (!Number.isFinite(ultima)) continue;
    // Un reloj corrido puede dar una marca en el futuro: eso es actividad
    // recientísima, no un dato a descartar.
    if (ultima < corte) continue;
    s.add(String(id));
  }
  return s;
}
