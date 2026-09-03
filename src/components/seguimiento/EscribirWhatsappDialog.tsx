import { MessageCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PanelConversacion from '@/components/seguimiento/PanelConversacion';
import { useAtencionPedido } from '@/hooks/useAtencionPedido';
import type { ModuloEnvio } from '@/hooks/useEnviarWhatsapp';
import type { DatosPedido } from '@/lib/plantillasMeta';
import type { ActividadChatOrden } from '@/lib/actividadChat';

/**
 * Escribirle al cliente por WhatsApp sin salir de Guardian — leyendo primero
 * lo que dijo.
 *
 * ⛔ EL CUERPO YA NO VIVE ACÁ (3-sep-2026). Todo lo que hace —leer el hilo,
 * decidir la ventana de 24 h, ofrecer plantillas, enviar y verificar— está en
 * `PanelConversacion`, porque la bandeja `/inbox` necesita exactamente lo mismo
 * pero SIN modal, al lado de la cola. Copiarlo habría dejado dos definiciones
 * del mismo hecho, que es la trampa que este proyecto ya pagó varias veces.
 *
 * Este archivo es el MARCO: un diálogo con título. Nada más. Las seis pantallas
 * que lo abren (SegBoard, CrmTable, CallView, CrmCallView, NovedadView y la
 * card de chat) siguen llamándolo igual, con los mismos props.
 */
export default function EscribirWhatsappDialog({ open, onOpenChange, externalId, dbId, nombre, estado, phone, actividad, datos, modulo, onEnviado }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  externalId: string;
  /** `orders.id`. Con esto el pedido queda marcado como EN ATENCIÓN mientras el
   *  chat está abierto, para que no se le escriba (ni se le llame) dos veces.
   *  Opcional: sin él el chat funciona igual, solo que sin la marca. */
  dbId?: string | null;
  nombre?: string | null;
  estado?: string | null;
  /** Opcional: si viene, el contador de Seguimiento baja apenas se envía, sin
   *  esperar a que alguien recargue. Ver `eventosGestion.ts`. */
  phone?: string | null;
  actividad?: ActividadChatOrden | null;
  /** Guía, transportadora, ciudad… con lo que se rellenan los huecos de una
   *  plantilla aprobada. */
  datos?: DatosPedido;
  /** Desde qué pantalla se escribe. Decide el prefijo del touchpoint: `SEG:%`
   *  cuenta como gestión de Seguimiento, y escribir desde Confirmar es un
   *  intento de contacto, no la gestión de esa pantalla. */
  modulo?: ModuloEnvio;
  onEnviado?: () => void;
}) {
  // Mientras este chat está abierto, el pedido queda EN ATENCIÓN: es lo que
  // evita que dos personas le escriban o lo llamen a la vez. Se suelta al
  // cerrar. El dueño no marca nada (ver el hook).
  useAtencionPedido(dbId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ⛔ El clic NO puede salir de acá (28-ago-2026, reportado por el dueño:
          *"le doy en la X para salirme y lo que hace es entrar al pedido"*).
          Radix dibuja esto en un PORTAL, así que en el DOM cuelga del <body> —
          pero React burbujea por su propio árbol, y ahí el padre sigue siendo la
          tarjeta, que tiene onClick para abrir el pedido. Cerrar el chat te
          metía en la ficha.
          Va en el diálogo y no en cada tarjeta porque lo abren SEIS pantallas
          y varias de ellas también son filas clicables. */}
      <DialogContent className="max-w-xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessageCircle size={16} className="text-success" aria-hidden="true" />
            {nombre || 'El cliente'} por WhatsApp
          </DialogTitle>
        </DialogHeader>

        <PanelConversacion
          activo={open}
          externalId={externalId}
          nombre={nombre}
          estado={estado}
          phone={phone}
          actividad={actividad}
          datos={datos}
          modulo={modulo}
          onEnviado={onEnviado}
        />
      </DialogContent>
    </Dialog>
  );
}
