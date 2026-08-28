import { getTrackingUrl } from './orderUtils';
import type { DatosPedido } from './plantillasMeta';

/**
 * Completa los datos del pedido con el **link de rastreo** ya armado.
 *
 * ── Por qué existe (28-ago-2026) ────────────────────────────────────────────
 * Varias plantillas tienen un hueco para el link ("Puede seguir su envío en
 * todo momento aquí 👉 {{3}}"). Meta no le pone etiqueta a ese hueco, así que
 * la sugerencia caía al EJEMPLO —una URL de Servientrega— y esa URL contiene la
 * palabra `tracking`, que matchea la regla de guía. Al cliente le llegaba:
 *
 *     Puede seguir su envío en todo momento aquí 👉 V123456789
 *
 * Un número donde va un link. `plantillasMeta.ts` ya no lo confunde, pero para
 * que el hueco se llene con el link DE VERDAD alguien tiene que armarlo, y eso
 * lo sabe hacer `getTrackingUrl` (que conoce la URL de cada transportadora por
 * país y lee el país activo del módulo, puesto por `StoreContext`).
 *
 * ⛔ Vive acá, en UNA función, y no repetido en las seis pantallas que abren el
 * cuadro de WhatsApp (SegBoard, CallView, CrmCallView, CrmTable, NovedadView,
 * OrderDetailPage, InboxPage). Seis copias de la misma línea es la receta para
 * que en cinco se arregle y en la sexta siga saliendo el número pelado.
 *
 * ⛔ Solo se acepta un link que lleve la GUÍA ADENTRO. Varias transportadoras
 * del mapa no admiten la guía en la URL y `getTrackingUrl` devuelve su portada:
 * mandarle a un cliente *"seguí tu envío aquí 👉 servientrega.com.ec"* es
 * mandarlo a una página en blanco a que busque solo. Se compara contra la
 * portada de esa misma transportadora en vez de mirar cómo termina la URL: así
 * la regla no depende de un detalle interno del mapa de rastreo.
 *
 * Sin link utilizable devuelve el dato tal cual, con el hueco vacío: la
 * plantilla queda incompleta y el botón la salta. Es lo correcto — mandar la
 * guía suelta en el lugar del link es peor que no mandar el mensaje.
 */
export function conRastreo(datos: DatosPedido | undefined | null): DatosPedido {
  const d = datos ?? {};
  // Si quien llama ya lo calculó, se respeta: puede saber algo que acá no.
  if (d.rastreoUrl) return d;
  const transportadora = d.transportadora ?? '';
  const guia = String(d.guia ?? '').trim();
  if (!guia) return d;
  const url = getTrackingUrl(transportadora, guia);
  if (!url) return d;
  const portada = getTrackingUrl(transportadora, '');
  return url !== portada ? { ...d, rastreoUrl: url } : d;
}
