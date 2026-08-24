import { classifySegEstado } from './segStatus';

/**
 * Lo que se le escribe al cliente, según dónde está el paquete.
 *
 * No son "plantillas de WhatsApp" (las de Meta, aprobadas): son ARRANQUES de
 * mensaje para que la asesora no empiece de cero a las 9 de la mañana. Se
 * pueden editar antes de mandar — de hecho el cuadro se abre con el texto
 * seleccionable, no bloqueado.
 *
 * Regla de escritura: primero el hecho (qué pasó con SU pedido), después la
 * pregunta concreta. Nada de "esperamos su pronta respuesta".
 */
export interface Plantilla { titulo: string; texto: string }

const nom = (nombre?: string | null) => {
  const limpio = String(nombre || '').trim().split(/\s+/)[0];
  return limpio ? limpio.charAt(0).toUpperCase() + limpio.slice(1).toLowerCase() : '';
};

export function plantillasPara(estado: string | null | undefined, nombre?: string | null): Plantilla[] {
  const hola = nom(nombre) ? `Hola ${nom(nombre)}` : 'Hola';
  const fase = classifySegEstado(estado || '');

  if (fase === 'oficina') {
    return [
      {
        titulo: 'Llegó a la agencia',
        texto: `${hola}, tu pedido ya llegó a la agencia y te está esperando. ¿Qué día puedes pasar a retirarlo?`,
      },
      {
        titulo: 'Se devuelve si no lo retiran',
        texto: `${hola}, tu pedido lleva varios días en la agencia. Si no lo retiras esta semana la transportadora lo devuelve. ¿Puedes ir hoy o mañana?`,
      },
      {
        titulo: 'Ofrecer llevárselo',
        texto: `${hola}, ¿se te complica ir hasta la agencia? Cuéntame y vemos cómo te lo hacemos llegar.`,
      },
    ];
  }
  if (fase === 'novedad' || fase === 'novedad_sol') {
    return [
      {
        titulo: 'Confirmar dirección',
        texto: `${hola}, la transportadora no pudo entregar tu pedido. ¿Me confirmas la dirección exacta y una referencia para volver a intentarlo?`,
      },
      {
        titulo: 'Coordinar nueva entrega',
        texto: `${hola}, vamos a reintentar la entrega de tu pedido. ¿Qué día y en qué horario estás en casa?`,
      },
    ];
  }
  if (fase === 'reparto' || fase === 'transito') {
    return [
      {
        titulo: 'Llega hoy',
        texto: `${hola}, tu pedido sale hoy para tu dirección. ¿Vas a estar para recibirlo?`,
      },
      {
        titulo: 'Quién recibe',
        texto: `${hola}, ¿me confirmas quién recibe el pedido y en qué horario? Así el repartidor no viaja en vano.`,
      },
    ];
  }
  if (fase === 'devolucion' || fase === 'devolucion_transito' || fase === 'rechazado') {
    return [
      {
        titulo: 'Rescate',
        texto: `${hola}, tu pedido se está devolviendo. Si todavía lo quieres, lo despachamos de nuevo sin costo extra. ¿Te lo reenvío?`,
      },
    ];
  }
  return [
    {
      titulo: 'Cómo va tu pedido',
      texto: `${hola}, te escribo por tu pedido. ¿Todo bien con la entrega o necesitas que cambiemos algo?`,
    },
  ];
}
