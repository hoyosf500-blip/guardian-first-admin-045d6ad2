import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CommunicationLog from './CommunicationLog';
import type { TimelineEvent } from '@/lib/timelineBuilder';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
    li: ({ children, ...props }: ComponentProps<'li'>) => <li {...props}>{children}</li>,
  },
}));

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'ev-1',
    timestamp: new Date('2026-04-15T10:00:00Z'),
    category: 'status',
    title: 'Test Event',
    ...overrides,
  };
}

describe('CommunicationLog', () => {
  it('shows empty state when no communication events', () => {
    const events = [
      makeEvent({ category: 'status', title: 'Confirmado' }),
      makeEvent({ id: 'e2', category: 'note', title: 'Una nota' }),
    ];
    render(<CommunicationLog events={events} />);
    expect(screen.getByText(/Aún no hay comunicaciones/)).toBeTruthy();
  });

  it('shows call events', () => {
    const events = [
      makeEvent({ category: 'call', title: 'Llamada', description: 'Llamada saliente' }),
    ];
    render(<CommunicationLog events={events} />);
    expect(screen.getByText('Llamada')).toBeTruthy();
  });

  it('shows whatsapp events', () => {
    const events = [
      makeEvent({ category: 'whatsapp', title: 'WhatsApp', description: 'Mensaje enviado' }),
    ];
    render(<CommunicationLog events={events} />);
    expect(screen.getByText('WhatsApp')).toBeTruthy();
  });

  it('shows sms events', () => {
    const events = [
      makeEvent({ category: 'sms', title: 'SMS', description: 'Plantilla cobro' }),
    ];
    render(<CommunicationLog events={events} />);
    expect(screen.getByText('SMS')).toBeTruthy();
  });

  it('filters out non-communication events', () => {
    const events = [
      makeEvent({ id: 'e1', category: 'call', title: 'Llamada' }),
      makeEvent({ id: 'e2', category: 'status', title: 'Confirmado' }),
      makeEvent({ id: 'e3', category: 'dropi', title: 'Pedido creado' }),
    ];
    render(<CommunicationLog events={events} />);
    expect(screen.getByText('Llamada')).toBeTruthy();
    expect(screen.queryByText('Confirmado')).toBeNull();
    expect(screen.queryByText('Pedido creado')).toBeNull();
  });

  it('renders the section title', () => {
    render(<CommunicationLog events={[]} />);
    expect(screen.getByText(/Bitácora de comunicaciones/)).toBeTruthy();
  });

  it('shows instruction text in empty state', () => {
    render(<CommunicationLog events={[]} />);
    expect(screen.getByText(/Llamar/)).toBeTruthy();
    expect(screen.getByText(/WhatsApp/)).toBeTruthy();
  });

  it('has role="log" and aria-live for accessibility', () => {
    const { container } = render(<CommunicationLog events={[]} />);
    const logEl = container.querySelector('[role="log"]');
    expect(logEl).toBeTruthy();
    expect(logEl?.getAttribute('aria-live')).toBe('polite');
    expect(logEl?.getAttribute('aria-label')).toBe('Bitácora de comunicaciones');
  });
});
