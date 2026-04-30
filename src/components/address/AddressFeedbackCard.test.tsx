import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddressFeedbackCard } from './AddressFeedbackCard';

const baseProps = {
  decision: 'green' as const,
  missingFields: [] as string[],
  suggestedMessage: '',
  isAdmin: false,
  onOverrideChange: vi.fn(),
  carrier: '',
};

describe('AddressFeedbackCard', () => {
  it('green muestra "Dirección verificada"', () => {
    render(<AddressFeedbackCard {...baseProps} />);
    expect(screen.getByText(/verificada/i)).toBeInTheDocument();
  });

  it('pickup_office muestra carrier', () => {
    render(<AddressFeedbackCard {...baseProps} decision="pickup_office" carrier="Interrapidísimo" />);
    expect(screen.getByText(/retiro/i)).toBeInTheDocument();
    expect(screen.getByText(/Interrapidísimo/)).toBeInTheDocument();
  });

  it('yellow muestra checks', () => {
    render(<AddressFeedbackCard {...baseProps} decision="yellow" missingFields={['barrio', 'complemento']} />);
    expect(screen.getByText(/barrio/i)).toBeInTheDocument();
    expect(screen.getByText(/referencia/i)).toBeInTheDocument();
  });

  it('red muestra missing_fields + botón Copiar', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="Hola Carlos" />);
    expect(screen.getByText(/falta/i)).toBeInTheDocument();
    expect(screen.getByText(/Hola Carlos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copiar/i })).toBeInTheDocument();
  });

  it('red + admin muestra checkbox override', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="x" isAdmin={true} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('red + non-admin NO muestra checkbox', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="x" isAdmin={false} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('botón copiar invoca clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="Mensaje a copiar" />);
    fireEvent.click(screen.getByRole('button', { name: /copiar/i }));
    expect(writeText).toHaveBeenCalledWith('Mensaje a copiar');
  });
});
