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

  it('red + non-admin SÍ muestra checkbox (operadora destraba tras verificar con cliente)', () => {
    // Cambio 2026-05-05: antes RED ocultaba el override para no-admin y dejaba
    // pedidos válidos imposibles de confirmar cuando el heurístico/Google/Haiku
    // marcaba mal la dirección (rural, complementos tipo "18a19", barrios
    // nuevos). Ahora la operadora ve el checkbox con texto enfático.
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} isAdmin={false} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText(/Verifiqué la dirección con el cliente/i)).toBeInTheDocument();
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

  it('muestra sugerencia cuando addressSuggestion.hasEnoughInfo es true en yellow', () => {
    render(<AddressFeedbackCard
      decision="yellow"
      missingFields={['tipo_via']}
      addressSuggestion={{ suggested: 'Calle 21 # 10-78, Barrio el 12, Fonseca', hasEnoughInfo: true }}
      isAdmin={false}
      onOverrideChange={() => {}}
    />);
    expect(screen.getByText(/Cómo debería verse/i)).toBeInTheDocument();
    expect(screen.getByText(/Calle 21 # 10-78/)).toBeInTheDocument();
  });

  it('NO muestra sugerencia si hasEnoughInfo es false', () => {
    render(<AddressFeedbackCard
      decision="red"
      missingFields={['numero_casa']}
      addressSuggestion={{ suggested: '', hasEnoughInfo: false }}
      isAdmin={false}
      onOverrideChange={() => {}}
    />);
    expect(screen.queryByText(/Cómo debería verse/i)).not.toBeInTheDocument();
  });

  it('Bug 2: muestra missingNote cuando hay info parcial', () => {
    render(<AddressFeedbackCard
      decision="yellow"
      missingFields={['numero_casa']}
      addressSuggestion={{
        suggested: 'Calle 7A en Tumaco, Nariño',
        missingNote: 'Falta confirmar: pídele al cliente el número exacto de la casa con guion (ej. 23-45).',
        hasEnoughInfo: true,
      }}
      isAdmin={false}
      onOverrideChange={() => {}}
    />);
    expect(screen.getByText('Calle 7A en Tumaco, Nariño')).toBeInTheDocument();
    expect(screen.getByText(/Falta confirmar/)).toBeInTheDocument();
  });
});
