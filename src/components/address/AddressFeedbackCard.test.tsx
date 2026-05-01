import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AddressFeedbackCard } from './AddressFeedbackCard';

const baseProps = {
  decision: 'green' as const,
  missingFields: [] as string[],
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

  it('red + admin muestra checkbox override', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} isAdmin={true} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('red + non-admin NO muestra checkbox', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} isAdmin={false} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('muestra sugerencia cuando suggestedAddress está poblado y decision es red', () => {
    render(<AddressFeedbackCard
      decision="red"
      missingFields={['numero_casa']}
      suggestedAddress="Calle 50 # 23-45, Barrio Laureles, Medellín"
      isAdmin={false}
      onOverrideChange={() => {}}
    />);
    expect(screen.getByText('¿Quisiste decir?')).toBeInTheDocument();
    expect(screen.getByText(/Calle 50 # 23-45/)).toBeInTheDocument();
  });
});
