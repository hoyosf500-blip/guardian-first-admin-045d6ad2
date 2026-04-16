import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Timeline from './Timeline';
import type { TimelineEvent } from '@/lib/timelineBuilder';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: {
    li: ({ children, ...props }: any) => <li {...props}>{children}</li>,
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
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

describe('Timeline', () => {
  it('shows empty state when no events', () => {
    render(<Timeline events={[]} emptyText="Nada aqui" />);
    expect(screen.getByText('Nada aqui')).toBeTruthy();
  });

  it('shows default empty text when none provided', () => {
    render(<Timeline events={[]} />);
    expect(screen.getByText('Sin eventos para mostrar')).toBeTruthy();
  });

  it('renders event title', () => {
    const events = [makeEvent({ title: 'Pedido creado' })];
    render(<Timeline events={events} />);
    expect(screen.getByText('Pedido creado')).toBeTruthy();
  });

  it('renders event description', () => {
    const events = [makeEvent({ title: 'Cancelado', description: 'No quiere' })];
    render(<Timeline events={events} />);
    expect(screen.getByText('No quiere')).toBeTruthy();
  });

  it('renders actor name', () => {
    const events = [makeEvent({ actor: 'Maria' })];
    render(<Timeline events={events} />);
    expect(screen.getByText(/por Maria/)).toBeTruthy();
  });

  it('filters by allowed categories', () => {
    const events = [
      makeEvent({ id: 'e1', category: 'call', title: 'Llamada' }),
      makeEvent({ id: 'e2', category: 'note', title: 'Nota importante' }),
    ];
    render(<Timeline events={events} allowedCategories={['call']} />);
    expect(screen.getByText('Llamada')).toBeTruthy();
    expect(screen.queryByText('Nota importante')).toBeNull();
  });

  it('shows empty state when all events are filtered out', () => {
    const events = [makeEvent({ category: 'note', title: 'Solo notas' })];
    render(<Timeline events={events} allowedCategories={['call']} emptyText="Sin llamadas" />);
    expect(screen.getByText('Sin llamadas')).toBeTruthy();
  });

  it('renders multiple events', () => {
    const events = [
      makeEvent({ id: 'e1', title: 'Primero' }),
      makeEvent({ id: 'e2', title: 'Segundo', timestamp: new Date('2026-04-14T10:00:00Z') }),
    ];
    render(<Timeline events={events} />);
    expect(screen.getByText('Primero')).toBeTruthy();
    expect(screen.getByText('Segundo')).toBeTruthy();
  });

  it('renders in compact mode without day separators', () => {
    const events = [
      makeEvent({ id: 'e1', title: 'Evento A', timestamp: new Date('2026-04-15T10:00:00Z') }),
      makeEvent({ id: 'e2', title: 'Evento B', timestamp: new Date('2026-04-14T10:00:00Z') }),
    ];
    const { container } = render(<Timeline events={events} compact />);
    // In compact mode, day labels should not be present
    const dayLabels = container.querySelectorAll('.uppercase.tracking-wider');
    expect(dayLabels.length).toBe(0);
  });

  it('has aria-label on the events list', () => {
    const events = [makeEvent({ id: '1', title: 'Test' })];
    const { container } = render(<Timeline events={events} />);
    const list = container.querySelector('ol[aria-label]');
    expect(list).toBeTruthy();
    expect(list?.getAttribute('aria-label')).toBe('Eventos del pedido');
  });
});
