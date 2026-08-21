import { useCallback } from 'react';
import type { OrderData } from '@/lib/orderUtils';
import { getWhatsAppPhone, getTrackingUrl } from '@/lib/orderUtils';
import { classifySegEstado } from '@/lib/segStatus';
import { formatCOP } from '@/lib/utils';
import { mensajeSeguimiento, urlWhatsApp } from '@/lib/mensajeSeguimiento';
import { useRecordGestion } from '@/hooks/useRecordGestion';

// Zona horaria por país, SOLO para calcular el día del plazo de la agencia.
// CO y EC comparten -05; GT va en -06 y un plazo corrido un día en el mensaje
// es exactamente el tipo de detalle que hace que el cliente llegue tarde.
const TZ_POR_PAIS: Record<string, string> = {
  CO: 'America/Bogota',
  EC: 'America/Guayaquil',
  GT: 'America/Guatemala',
};

/**
 * Abre WhatsApp con el mensaje del pedido YA ESCRITO y registra el intento de
 * contacto.
 *
 * Por qué es un hook y no un botón: SegBoard (tablero), CrmTable (lista) y
 * CrmCallView (ficha) tienen tres estilos de botón distintos y ya calibrados.
 * Lo que NO puede volver a divergir es el mensaje ni el registro del contacto
 * — esa es la lección de ProductoTile (dos copias, se arregló una sola y el bug
 * reapareció en la otra pantalla).
 *
 * Devuelve `false` si no había teléfono usable, para que el llamador pueda
 * avisar en vez de abrir una pestaña muerta.
 *
 * El touchpoint va como `WHATSAPP:` — es un INTENTO DE CONTACTO, no una
 * gestión: no matchea `SEG:%`, así que no mueve el contador de "Gestioné hoy"
 * ni esconde la tarjeta. Escribirle a un cliente no es haber resuelto el pedido.
 */
export function useWhatsAppSeguimiento(countryCode?: string | null) {
  const recordGestion = useRecordGestion();

  return useCallback(
    (o: OrderData): boolean => {
      const telefono = o.phone ? getWhatsAppPhone(o.phone, countryCode) : '';
      const fase = classifySegEstado(o.estado);

      const texto = mensajeSeguimiento({
        nombre: o.nombre,
        producto: o.producto,
        fase,
        ciudad: o.ciudad,
        transportadora: o.transportadora,
        guia: o.guia,
        trackingUrl: getTrackingUrl(o.transportadora, o.guia, countryCode),
        // formatCOP es country-aware (COP entero · USD con centavos · GTQ).
        valorTexto: o.valor > 0 ? formatCOP(o.valor) : '',
        novedad: o.novedad,
        lastMovementAt: o.lastMovementAt,
        timeZone: TZ_POR_PAIS[(countryCode || 'CO').toUpperCase()] ?? 'America/Bogota',
      });

      const url = urlWhatsApp(telefono, texto);
      if (!url) return false;

      window.open(url, '_blank', 'noopener,noreferrer');
      // El registro no puede bloquear la apertura del chat: si falla, la asesora
      // ya está escribiéndole al cliente y eso es lo que importa.
      void recordGestion(o.phone, 'WHATSAPP', `escribió — ${fase}`);
      return true;
    },
    [countryCode, recordGestion],
  );
}
