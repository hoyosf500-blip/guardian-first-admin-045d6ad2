import { classifySegEstado, esColaDeConfirmacion } from './segStatus';

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

  // ⛔ La cola de CONFIRMAR. `PENDIENTE CONFIRMACION` clasifica como `otros`
  // (no es una fase de Seguimiento — ver `OTROS_ESPERADOS` en segStatus.ts), y
  // hasta el 30-ago-2026 caía en el fallback de abajo: la asesora de Confirmar
  // abría el cuadro y lo único que le ofrecíamos era "¿todo bien con la
  // entrega?" sobre un pedido que NO está despachado ni tiene entrega. Es la
  // pantalla donde más se escribe del día y era la peor servida.
  // Estos arranques son los cuatro momentos reales de esa cola: no contesta,
  // confirmar, falta la dirección, y el que dijo "después te digo".
  if (esColaDeConfirmacion(estado)) {
    return [
      {
        titulo: 'No contestó la llamada',
        texto: `${hola}, te acabo de llamar por tu pedido y no logré ubicarte. ¿Te queda mejor que te llame más tarde o lo confirmamos por aquí?`,
      },
      {
        titulo: 'Confirmar el pedido',
        texto: `${hola}, te escribo para confirmar tu pedido antes de despacharlo. ¿Me confirmas que lo quieres y que la dirección sigue siendo la misma?`,
      },
      {
        titulo: 'Falta la dirección exacta',
        texto: `${hola}, para poder despachar tu pedido me falta la dirección completa: calle y número, y una referencia cerquita (una tienda, una esquina o qué queda al frente). ¿Me la pasas?`,
      },
      {
        titulo: 'Lo iba a pensar',
        texto: `${hola}, te lo dejo apartado sin compromiso: pagas recién cuando lo recibes en la mano. ¿Te lo despacho esta semana?`,
      },
    ];
  }
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
