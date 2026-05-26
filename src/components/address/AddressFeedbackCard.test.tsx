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

  // 2026-05-26: el gate de despacho por dirección y las sugerencias de Google
  // Maps se quitaron a pedido. La card ahora es SOLO informativa: lista qué
  // confirmar/falta, sin checkbox de override ni "¿Quisiste decir?". Estos tests
  // validan el comportamiento actual (y que el UI removido ya no aparezca).
  it('red lista los faltantes y NO muestra checkbox de override', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} isAdmin={true} />);
    expect(screen.getByText(/falta/i)).toBeInTheDocument();
    expect(screen.getByText(/número de la casa/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('red para operadora (no-admin): mismo card informativo, sin override', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} isAdmin={false} />);
    expect(screen.getByText(/falta/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('NO muestra sugerencia de dirección (Google Maps removido) en red', () => {
    render(<AddressFeedbackCard
      decision="red"
      missingFields={['numero_casa']}
      suggestedAddress="Calle 50 # 23-45, Barrio Laureles, Medellín"
      isAdmin={false}
      onOverrideChange={() => {}}
    />);
    expect(screen.queryByText('¿Quisiste decir?')).not.toBeInTheDocument();
    expect(screen.queryByText(/Calle 50 # 23-45/)).not.toBeInTheDocument();
    // Sigue listando lo que falta (es lo informativo que queda).
    expect(screen.getByText(/número de la casa/i)).toBeInTheDocument();
  });

  it('NO muestra "Cómo debería verse" (suggestion removida) en yellow', () => {
    render(<AddressFeedbackCard
      decision="yellow"
      missingFields={['tipo_via']}
      addressSuggestion={{ suggested: 'Calle 21 # 10-78, Barrio el 12, Fonseca', hasEnoughInfo: true }}
      isAdmin={false}
      onOverrideChange={() => {}}
    />);
    expect(screen.queryByText(/Cómo debería verse/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Calle 21 # 10-78/)).not.toBeInTheDocument();
    expect(screen.getByText(/tipo de vía/i)).toBeInTheDocument();
  });

  it('NO muestra missingNote (suggestion removida)', () => {
    render(<AddressFeedbackCard
      decision="yellow"
      missingFields={['numero_casa']}
      addressSuggestion={{
        suggested: 'Calle 7A en Tumaco, Nariño',
        missingNote: 'Falta confirmar: pídele al cliente el número exacto.',
        hasEnoughInfo: true,
      }}
      isAdmin={false}
      onOverrideChange={() => {}}
    />);
    expect(screen.queryByText('Calle 7A en Tumaco, Nariño')).not.toBeInTheDocument();
    expect(screen.queryByText(/Falta confirmar/)).not.toBeInTheDocument();
  });
});
