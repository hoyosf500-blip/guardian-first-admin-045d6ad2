import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DespachoGateButton } from './DespachoGateButton';

const baseGate = {
  validation_decision: 'green' as const,
  telefonoValido: true,
  documentoSiCoordinadora: true,
  isAdmin: false,
  overrideChecked: false,
};

describe('DespachoGateButton', () => {
  it('green: button habilitado', () => {
    const onConfirm = vi.fn();
    render(<DespachoGateButton gate={baseGate} onConfirm={onConfirm}>Confirmar</DespachoGateButton>);
    const btn = screen.getByRole('button', { name: /confirmar/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('red sin override: button disabled', () => {
    render(<DespachoGateButton gate={{ ...baseGate, validation_decision: 'red' }} onConfirm={vi.fn()}>Confirmar</DespachoGateButton>);
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
  });

  it('phone invalid: button disabled', () => {
    render(<DespachoGateButton gate={{ ...baseGate, telefonoValido: false }} onConfirm={vi.fn()}>Confirmar</DespachoGateButton>);
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
  });
});
