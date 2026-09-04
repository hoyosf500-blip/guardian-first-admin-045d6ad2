// Cortacircuitos del robot Shopify → Dropi: dejar de martillar una causa que no
// puede salir bien, sin dejar de mirarla nunca.
//
// ── LO QUE SE MIDIÓ (Ecuador, 4-sep-2026) ──────────────────────────────────
// En 48 h: 191 corridas del robot, y 103 de ellas terminaron en "0 de N
// subidos" — 778 intentos contra el panel web de Dropi que NO podían salir
// bien. En el mismo lapso el robot SÍ creó 150 pedidos, así que no está roto:
// está martillando. Hoy hay 82 pedidos atascados, y 4 causas explican 52:
// el producto 147152 sin stock (39), el shampoo variable (9) y dos ciudades de
// Galápagos sin método de envío (4 + 2).
//
// ⛔ Y ojo con la premisa: el plan de esta tanda decía "el robot las reintenta
// cada 15 minutos". ESO ERA FALSO y medirlo lo desmintió. `ERROR_COOLDOWN_MS`
// (2 h) y `MAX_AGE_MS` (3 días) ya limitan a CADA pedido. El desperdicio no es
// la frecuencia de uno: es la SUMA de 82 repartidos en esas corridas.
//
// ── POR QUÉ IMPORTA, QUE NO ES EL GASTO ────────────────────────────────────
// `selectAutoPushCandidates` ordena del MÁS VIEJO al más nuevo para drenar el
// backlog en orden, y los atascados son, por definición, los más viejos. Con
// `PER_STORE_CAP = 20` y 110 s de pared (≈17 pushes de ~6 s), los que no pueden
// salir se comen la CABEZA de la cola y una venta fresca —que sí habría
// entrado— espera a la corrida siguiente. El daño no es la factura de Dropi:
// es el orden de atención.
//
// ── LAS TRES REGLAS ────────────────────────────────────────────────────────
// 1. Un pedido que NUNCA falló no se frena JAMÁS. Una venta nueva siempre tiene
//    su turno completo. Esto no es una concesión: es el detector de
//    recuperación más barato que hay — si el dueño repone el stock, la próxima
//    venta de ese producto entra sola y nadie tuvo que avisarle a nadie.
// 2. Una causa con `umbral` pedidos fallando entra en pausa, y de ahí en más
//    pasa UNA sonda por `sondaMs`: la más vieja, que es la que más urge.
// 3. La pausa se suelta SOLA. Los pausados dejan de reintentarse → su
//    `pushed_at` se congela → envejecen fuera de `ventanaMs` → el conteo baja
//    del umbral → la causa revive y entra un barrido completo. Si sigue rota,
//    se vuelve a pausar. Nadie tiene que acordarse de despausar nada, y una
//    pausa no puede durar más que `ventanaMs`.
//
// ⛔ LO QUE ESTE ARCHIVO TIENE PROHIBIDO: esconder. Una corrida donde todo
// quedó en pausa se ve, desde afuera, IDÉNTICA a una corrida sin trabajo. Por
// eso `enPausa` sale contado y con nombre para que el llamador lo escriba en
// `sync_logs`, y `useAutoPushHealth` lo suma a su contador. Sin eso, el día que
// esto se prenda el panel se pinta VERDE con 52 ventas paradas — que es
// exactamente el incidente del cron de la wallet (`wallet_cron_fallaba_en_verde`),
// otra vez y por la misma puerta.

import { causaDeFalla } from "./causaFalla.ts";

/** Cuántos pedidos DISTINTOS fallando por la misma causa la ponen en pausa.
 *  Tres es el número más chico que no puede ser casualidad: dos fallos seguidos
 *  todavía pueden ser dos direcciones raras; tres es un patrón. */
export const UMBRAL_PAUSA = 3;

/** Cada cuánto pasa UNA sonda por causa pausada. Una hora deja 24 tiros por día
 *  para descubrir que el dueño repuso el stock, contra los ~389 diarios que se
 *  están gastando hoy. */
export const SONDA_MS = 60 * 60 * 1000;

/** Un fallo más viejo que esto ya no sostiene la pausa. Es lo que hace que la
 *  pausa caduque sola (regla 3). */
export const VENTANA_PAUSA_MS = 24 * 60 * 60 * 1000;

export interface IntentoPrevio {
  status: string;
  /** El texto crudo que devolvió Dropi. De acá sale la causa. */
  errorMessage: string | null;
  pushedAtMs: number;
}

export interface OpcionesCorte {
  nowMs: number;
  umbral?: number;
  sondaMs?: number;
  ventanaMs?: number;
}

export interface CausaPausada {
  clave: string;
  /** Cuántos pedidos la sostienen. */
  pedidos: number;
  /** Lo que lee una persona. Ya viene sin prefijos técnicos. */
  etiqueta: string;
  /** Cuándo se intentó por última vez algo de esta causa. */
  ultimoIntentoMs: number;
  /** true = pasa una sonda en ESTA corrida. */
  tocaSonda: boolean;
}

export interface Corte<T> {
  /** Los que se intentan de verdad, en el mismo orden que entraron. */
  aSubir: T[];
  /** Los que NO se intentan porque su causa está en pausa. */
  enPausa: T[];
  /** Las causas pausadas, ordenadas de más a menos pedidos. Va al log. */
  causas: CausaPausada[];
  /** Los que pasan COMO sonda. Subconjunto de `aSubir`. */
  sondas: T[];
}

interface Identificable {
  shopify_order_id: string;
  createdAtMs: number;
}

/**
 * Parte la lista de candidatos en los que se intentan y los que esperan.
 *
 * `candidatos` tiene que venir YA ordenado del más viejo al más nuevo — es lo
 * que hace `selectAutoPushCandidates` — porque la sonda es "el primero de su
 * causa", y ese orden es el que la vuelve determinista y la que más urge.
 *
 * `intentos` es el mapa completo de últimos intentos de la tienda, no solo el
 * de los candidatos: la pausa se cuenta sobre TODOS los que están fallando,
 * incluidos los que ahora mismo ni siquiera son candidatos.
 */
export function aplicarCortacircuitos<T extends Identificable>(
  candidatos: T[],
  intentos: Map<string, IntentoPrevio>,
  opts: OpcionesCorte,
): Corte<T> {
  const umbral = opts.umbral ?? UMBRAL_PAUSA;
  const sondaMs = opts.sondaMs ?? SONDA_MS;
  const ventanaMs = opts.ventanaMs ?? VENTANA_PAUSA_MS;

  // 1. Contar los fallos VIVOS por causa. Un fallo viejo no sostiene la pausa:
  //    ahí está la caducidad automática de la regla 3.
  const porCausa = new Map<string, { pedidos: number; etiqueta: string; ultimoIntentoMs: number }>();
  for (const it of intentos.values()) {
    if (it.status !== "error") continue;
    if (opts.nowMs - it.pushedAtMs > ventanaMs) continue;
    const c = causaDeFalla(it.errorMessage);
    // ⛔ `sin_verificar` (un 'error' sin texto) NO agrupa: son fallos de los que
    // no sabemos la razón y meterlos en una bolsa común pausaría cosas que no
    // tienen nada que ver entre sí. Sin causa conocida, se sigue reintentando.
    if (c.familia === "sin_verificar") continue;
    const prev = porCausa.get(c.clave);
    if (prev) {
      prev.pedidos++;
      if (it.pushedAtMs > prev.ultimoIntentoMs) prev.ultimoIntentoMs = it.pushedAtMs;
    } else {
      porCausa.set(c.clave, { pedidos: 1, etiqueta: c.etiqueta, ultimoIntentoMs: it.pushedAtMs });
    }
  }

  // 2. Las que pasan el umbral quedan en pausa, y se decide de una vez si a esta
  //    corrida le toca sonda.
  const pausadas = new Map<string, CausaPausada>();
  for (const [clave, v] of porCausa) {
    if (v.pedidos < umbral) continue;
    pausadas.set(clave, {
      clave,
      pedidos: v.pedidos,
      etiqueta: v.etiqueta,
      ultimoIntentoMs: v.ultimoIntentoMs,
      tocaSonda: opts.nowMs - v.ultimoIntentoMs >= sondaMs,
    });
  }

  // 3. Repartir. Se recorre en el orden que vino (más viejo primero), así la
  //    sonda de cada causa es su pedido más viejo.
  const aSubir: T[] = [];
  const enPausa: T[] = [];
  const sondas: T[] = [];
  const sondaUsada = new Set<string>();

  for (const c of candidatos) {
    const prev = intentos.get(c.shopify_order_id);
    // Regla 1: sin fallo previo propio, no se frena nunca.
    if (!prev || prev.status !== "error") { aSubir.push(c); continue; }
    const clave = causaDeFalla(prev.errorMessage).clave;
    const pausa = pausadas.get(clave);
    if (!pausa) { aSubir.push(c); continue; }
    if (pausa.tocaSonda && !sondaUsada.has(clave)) {
      sondaUsada.add(clave);
      aSubir.push(c);
      sondas.push(c);
      continue;
    }
    enPausa.push(c);
  }

  return {
    aSubir,
    enPausa,
    causas: [...pausadas.values()].sort((a, b) => b.pedidos - a.pedidos),
    sondas,
  };
}

/**
 * La línea que va al `sync_logs`. Se arma acá y no en el llamador para que el
 * texto que lee el panel y el que decide la pausa no puedan separarse nunca.
 *
 * Devuelve `""` si no hay nada en pausa, para que el mensaje no crezca cuando
 * no hay nada que contar.
 */
export function resumenPausa(corte: Corte<Identificable>): string {
  if (corte.enPausa.length === 0 && corte.causas.length === 0) return "";
  const top = corte.causas.slice(0, 3).map((c) => `${c.etiqueta} (${c.pedidos})`).join(" · ");
  const sonda = corte.sondas.length > 0 ? ` Sondas: ${corte.sondas.length}.` : "";
  // ⛔ La forma `en pausa: N` es la que lee `useAutoPushHealth`. Si se cambia
  // acá hay que cambiarla allá, y hay un guardián que lo exige.
  return ` en pausa: ${corte.enPausa.length} (${top}).${sonda}`;
}
