import { causaDeFalla, type Causa } from './causaFalla';
import type { ShopifyPendingItem } from '@/hooks/useShopifyPending';
import type { PushAttempt } from '@/hooks/useShopifyPushAttempts';

/**
 * Las ventas de Shopify que no llegaron a Dropi, agrupadas por MOTIVO.
 *
 * Por qué existe (medido el 4-sep-2026 en Ecuador, `shopify_pushed_orders` del
 * 28-ago al 4-sep): de 480 ventas intentadas, **85 nunca llegaron a Dropi**. El
 * equipo rescató 69 a mano — y esa carga manual es la que choca con el robot y
 * fabrica los duplicados. Las otras 16 seguían sin pedido, ~$506 sin despachar,
 * la más vieja de 151 horas. Nadie lo veía: el panel mostraba el motivo POR FILA
 * y nadie suma 85 filas a ojo.
 *
 * ⛔ Se calcula sobre los pendientes REALES que hoy muestra la reconciliación, no
 * sobre el histórico de intentos. Contar las 85 (de las que 69 ya están en Dropi)
 * sería inflar el número, que es exactamente el incidente "420 en Dropi vs 403".
 *
 * ⛔ Y con `pudoLeer` en false NO se devuelve ningún conteo: "no pude leer" y
 * "no hay ninguna" son cosas distintas y la pantalla las dice distinto.
 */

/** 3 horas: lo que el robot espera antes de subir, para darle lugar a Dropify. */
export const GRACIA_MS = 3 * 60 * 60 * 1000;
/** Más viejo que esto, el robot ya no lo toca: queda para la mano humana. */
export const TECHO_MS = 3 * 24 * 60 * 60 * 1000;
/** Un claim 'pending' más viejo que esto es un intento muerto, no uno en curso. */
export const PENDING_MUERTO_MS = 3 * 60 * 1000;

export interface VentaTrabada {
  item: ShopifyPendingItem;
  causa: Causa;
  plata: number;
  edadMs: number;
  ultimoIntentoMs: number;
}

export interface GrupoTrabado {
  clave: string;
  causa: Causa;
  ventas: VentaTrabada[];
  plata: number;
}

export interface BacklogDropi {
  /** false ⇒ la pantalla no puede afirmar NINGÚN número. */
  pudoLeer: boolean;
  /** Fallaron con un motivo concreto. Estas no se suben solas. */
  fallaron: VentaTrabada[];
  /** Quedaron indeterminadas: hay que mirar Dropi antes de reintentar. */
  sinVerificar: VentaTrabada[];
  /** Todavía dentro de la gracia: el robot las va a subir. No son un problema. */
  esperandoTurno: ShopifyPendingItem[];
  /** Pasaron el techo o no tienen teléfono: el robot ya las soltó. */
  nadieLasVaAIntentar: ShopifyPendingItem[];
  /** `fallaron` agrupadas por motivo, la que más plata primero. */
  grupos: GrupoTrabado[];
  plataTrabada: number;
  /** Edad de la venta más vieja que falló, en ms. 0 si no hay ninguna. */
  masViejaMs: number;
}

const VACIO: BacklogDropi = {
  pudoLeer: false, fallaron: [], sinVerificar: [], esperandoTurno: [],
  nadieLasVaAIntentar: [], grupos: [], plataTrabada: 0, masViejaMs: 0,
};

export function armarBacklogDropi(
  pending: ShopifyPendingItem[],
  attempts: Map<string, PushAttempt>,
  o: { ahoraMs: number; pudoLeer: boolean },
): BacklogDropi {
  if (!o.pudoLeer) return { ...VACIO, pudoLeer: false };

  const fallaron: VentaTrabada[] = [];
  const sinVerificar: VentaTrabada[] = [];
  const esperandoTurno: ShopifyPendingItem[] = [];
  const nadieLasVaAIntentar: ShopifyPendingItem[] = [];

  for (const item of pending) {
    const creadoMs = Date.parse(item.created_at);
    const edadMs = Number.isFinite(creadoMs) ? Math.max(0, o.ahoraMs - creadoMs) : 0;
    const intento = attempts.get(item.id);

    if (!intento) {
      // Sin intento todavía. ¿Lo va a intentar el robot, o ya lo soltó?
      if (item.sin_telefono || edadMs > TECHO_MS) nadieLasVaAIntentar.push(item);
      else esperandoTurno.push(item);
      continue;
    }

    const intentoMs = Date.parse(intento.pushed_at);
    const ultimoIntentoMs = Number.isFinite(intentoMs) ? intentoMs : 0;

    // Un claim 'pending' fresco es un push EN CURSO, no una falla.
    if (intento.status === 'pending' && o.ahoraMs - ultimoIntentoMs < PENDING_MUERTO_MS) {
      esperandoTurno.push(item);
      continue;
    }

    // Un 'created' que sigue apareciendo como pendiente es otra cosa: la orden
    // existe en Dropi y el cruce por teléfono no la ve. No es una venta trabada.
    if (intento.status === 'created') continue;

    const causa = causaDeFalla(intento.error_message);
    // El candado anti-duplicado cediendo NO es una venta trabada: hizo su trabajo.
    if (causa.familia === 'duplicado') continue;

    const trabada: VentaTrabada = {
      item, causa, plata: Number(item.total) || 0, edadMs, ultimoIntentoMs,
    };
    if (causa.familia === 'sin_verificar') sinVerificar.push(trabada);
    else fallaron.push(trabada);
  }

  const porClave = new Map<string, GrupoTrabado>();
  for (const v of fallaron) {
    const g = porClave.get(v.causa.clave)
      ?? { clave: v.causa.clave, causa: v.causa, ventas: [], plata: 0 };
    g.ventas.push(v);
    g.plata += v.plata;
    porClave.set(v.causa.clave, g);
  }
  const grupos = [...porClave.values()].sort((a, b) => b.plata - a.plata || b.ventas.length - a.ventas.length);

  return {
    pudoLeer: true,
    fallaron,
    sinVerificar,
    esperandoTurno,
    nadieLasVaAIntentar,
    grupos,
    plataTrabada: fallaron.reduce((s, v) => s + v.plata, 0),
    masViejaMs: fallaron.reduce((m, v) => Math.max(m, v.edadMs), 0),
  };
}

/** Cuándo le toca al robot esta venta. `yaPaso` = ya debería haberla intentado. */
export function cuandoLoIntentaElRobot(creadoMs: number, ahoraMs: number): {
  ms: number; yaPaso: boolean; fueraDeTecho: boolean;
} {
  const cuando = creadoMs + GRACIA_MS;
  return {
    ms: cuando,
    yaPaso: ahoraMs >= cuando,
    fueraDeTecho: ahoraMs - creadoMs > TECHO_MS,
  };
}
