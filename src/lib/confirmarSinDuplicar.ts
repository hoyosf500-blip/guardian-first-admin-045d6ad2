// ¿Se puede confirmar este pedido sin arriesgar un doble despacho?
//
// ── El pedido del dueño (3-sep-2026), textual ───────────────────────────────
// *"El problema de los duplicados es de ayer. Auditá todo el código y encontrá
// la solución, que esto está PROHIBIDO que pase, ya que le pone más trabajo al
// asesor. Le dio en confirmar y se duplica."* Y su asesora, el mismo día:
// *"Si usted mira, hay hartos cancelados en Dropi por eso."*
//
// ── Lo que la auditoría encontró, y por qué el aviso no alcanzaba ───────────
// El chip de DUPLICADO ya existía y ya detecta los dos casos
// (`buildActiveDupIndex`): otro pedido real en curso en Dropi, y **dos
// PENDIENTE CONFIRMACION del mismo teléfono en la misma cola**. O sea: el dato
// estaba en la pantalla.
//
// Pero era **solo un chip**. La asesora podía apretar «Confirmó» igual, con la
// tecla 1, con el atajo VIP o con el botón — y nada la frenaba. Confirmar los
// dos hace que Dropi le genere guía a cada uno: **dos guías, dos fletes, dos
// paquetes al mismo cliente**, y después alguien tiene que entrar al panel de
// Dropi a cancelar uno a mano. Eso es exactamente el trabajo de más que el
// dueño prohibió.
//
// Un aviso que se puede ignorar sin decir nada no es un candado. Acá el
// segundo pedido del mismo cliente exige una DECISIÓN explícita.
//
// ── Lo que este archivo NO hace, a propósito ────────────────────────────────
// ⛔ NO cancela, NO esconde y NO decide por ella. Un cliente **sí** puede
// comprar dos veces, y en este proyecto ya se mató el pedido REAL de un cliente
// por cancelar por sospecha (auditoría 13-ago-2026). Por eso la salida siempre
// existe y es de un clic: ella mira los dos y dice si son distintos.
//
// ⛔ Y no se pregunta dos veces por el mismo pedido: una vez que decidió, la
// respuesta vale. Volver a preguntar es la forma más rápida de enseñarle a
// apretar "sí" sin leer, que deja el candado peor que no tenerlo.
//
// Puro: sin red, sin React, sin reloj.

import type { ActiveDupAlert } from './orderAlerts';

export interface AvisoAntesDeConfirmar {
  /** true = hay que preguntar ANTES de mandar la confirmación a Dropi. */
  frena: boolean;
  /** Los otros pedidos en curso de ese mismo cliente. */
  gemelos: ActiveDupAlert[];
  /** El encabezado del diálogo, en el idioma de la operación. */
  titulo: string;
  /** Qué está en juego y qué tiene que mirar. Una frase. */
  detalle: string;
}

const SIN_AVISO: AvisoAntesDeConfirmar = { frena: false, gemelos: [], titulo: '', detalle: '' };

/** "#123 (EN TRANSITO)" · "#123 (por confirmar)" */
function nombrar(a: ActiveDupAlert): string {
  const estado = a.source === 'cola'
    ? 'por confirmar'
    : (a.estado || '').trim().toLowerCase() || 'en curso';
  return `#${a.externalId} (${estado})`;
}

/**
 * @param gemelos  lo que devuelve `dupAlertsFor` para ESTE pedido (ya excluye
 *                 el pedido mismo).
 * @param yaDecidio la asesora ya respondió por este pedido en esta sesión.
 */
export function avisoAntesDeConfirmar(
  gemelos: ActiveDupAlert[] | null | undefined,
  yaDecidio = false,
): AvisoAntesDeConfirmar {
  if (yaDecidio) return SIN_AVISO;
  const lista = (gemelos ?? []).filter((g) => g && g.externalId);
  if (lista.length === 0) return SIN_AVISO;

  // Los de la cola son el caso caro: los dos están sin confirmar, así que
  // confirmar los dos despacha dos veces. Van primero en el texto.
  const orden = [...lista].sort((a, b) => (a.source === 'cola' ? -1 : 0) - (b.source === 'cola' ? -1 : 0));
  const nombres = orden.slice(0, 3).map(nombrar).join(', ');
  const resto = orden.length > 3 ? ` y ${orden.length - 3} más` : '';

  return {
    frena: true,
    gemelos: orden,
    titulo: orden.length === 1
      ? 'Este cliente tiene otro pedido en curso'
      : `Este cliente tiene ${orden.length} pedidos más en curso`,
    detalle:
      `${nombres}${resto}. Si confirmás los dos, Dropi le genera una guía a cada uno: ` +
      `dos paquetes y dos fletes al mismo cliente. Miralos antes de seguir.`,
  };
}
