import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConversacionChat from './ConversacionChat';
import type { MensajeConversacion } from '@/lib/conversacion';

// El componente pregunta el canal de la tienda; acá no interesa cuál sea.
vi.mock('@/hooks/useCanalChat', () => ({
  useCanalChat: () => 'chateapro',
  nombreCanal: () => 'Chatea Pro',
}));

/**
 * Los avisos automáticos se PLIEGAN, no se esconden.
 *
 * ⛔ Medido el 2-sep-2026 sobre tres conversaciones reales de Colombia: 16, 16
 * y 20 avisos de sistema por hilo — hasta el 28% de los mensajes. Son el flujo
 * de Chatea Pro hablándose a sí mismo («Evento de Meta enviado con éxito»,
 * «Validando valor del flete en 3… 2… 1…»). Entre ellos se pierde lo que sí
 * importa.
 *
 * Pero esconderlos sería peor, y esta app ya pagó esa lección: entre esos
 * mismos avisos aparecen «No se encontraron transportadoras disponibles» y
 * «Hubo un problema al subir tu producto a Dropi», que son exactamente lo que
 * la asesora necesita ver cuando un pedido no avanza.
 */

let n = 0;
const msg = (o: Partial<MensajeConversacion>): MensajeConversacion => ({
  id: `m${++n}`, fechaMs: Date.parse('2026-09-02T15:00:00Z'), de: 'cliente',
  texto: '', tipo: 'text', autor: null, esMarcador: false, archivoUrl: null,
  ...o,
} as MensajeConversacion);

const pintar = (mensajes: MensajeConversacion[]) =>
  render(<ConversacionChat mensajes={mensajes} estado="ok" error={null} />);

describe('ConversacionChat — avisos automáticos', () => {
  it('agrupa los avisos seguidos en un solo renglón plegado', () => {
    pintar([
      msg({ texto: 'hola, quiero el pedido' }),
      msg({ de: 'sistema', texto: 'Ⓜ️ Evento de Meta enviado con éxito' }),
      msg({ de: 'sistema', texto: '🔍 Validando valor del flete en 3... 2... 1...' }),
      msg({ de: 'sistema', texto: '🎉 Felicidades por la nueva venta #97' }),
      msg({ de: 'negocio', texto: 'Listo, ya sale', autor: 'Bot' }),
    ]);
    expect(screen.getByText(/3 avisos automáticos del sistema/)).toBeTruthy();
    // Y lo que sí es conversación queda a la vista.
    expect(screen.getByText('hola, quiero el pedido')).toBeTruthy();
    expect(screen.getByText('Listo, ya sale')).toBeTruthy();
    // Plegado = no visible todavía.
    expect(screen.queryByText(/Felicidades por la nueva venta/)).toBeNull();
  });

  it('⛔ un clic los muestra: se pliegan, NO se esconden', () => {
    // Entre estos avisos vive «No se encontraron transportadoras», que es la
    // razón por la que el pedido no avanza. Tiene que poder verse.
    pintar([
      msg({ de: 'sistema', texto: 'Ⓜ️ Evento de Meta enviado con éxito' }),
      msg({ de: 'sistema', texto: '❌ No se encontraron transportadoras disponibles.' }),
    ]);
    fireEvent.click(screen.getByText(/2 avisos automáticos del sistema/));
    expect(screen.getByText(/No se encontraron transportadoras disponibles/)).toBeTruthy();
    expect(screen.getByText('ocultar')).toBeTruthy();
  });

  it('un aviso suelto se anuncia en singular', () => {
    pintar([
      msg({ texto: 'buenas' }),
      msg({ de: 'sistema', texto: '🟠 Subiendo a Dropi automáticamente...' }),
    ]);
    expect(screen.getByText(/1 aviso automático del sistema/)).toBeTruthy();
  });

  it('dos tandas separadas por conversación NO se juntan', () => {
    pintar([
      msg({ de: 'sistema', texto: 'aviso A' }),
      msg({ texto: 'el cliente dice algo' }),
      msg({ de: 'sistema', texto: 'aviso B' }),
      msg({ de: 'sistema', texto: 'aviso C' }),
    ]);
    expect(screen.getByText(/1 aviso automático del sistema/)).toBeTruthy();
    expect(screen.getByText(/2 avisos automáticos del sistema/)).toBeTruthy();
  });

  it('un hilo sin avisos no dibuja ningún renglón de más', () => {
    pintar([msg({ texto: 'hola' }), msg({ de: 'negocio', texto: 'buenas', autor: 'Bot' })]);
    expect(screen.queryByText(/avisos? automáticos? del sistema/)).toBeNull();
  });

  it('los mensajes del cliente y del negocio nunca se pliegan', () => {
    pintar([
      msg({ texto: 'necesito que llegue después de las 5' }),
      msg({ de: 'negocio', texto: 'anotado', autor: 'Fabián' }),
    ]);
    expect(screen.getByText('necesito que llegue después de las 5')).toBeTruthy();
    expect(screen.getByText('anotado')).toBeTruthy();
    expect(screen.getByText('Fabián')).toBeTruthy();
  });
});
