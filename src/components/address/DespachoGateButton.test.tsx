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

  it('red ya NO bloquea: button habilitado (semáforo informativo desde 2026-05-26)', () => {
    const onConfirm = vi.fn();
    render(<DespachoGateButton gate={{ ...baseGate, validation_decision: 'red' }} onConfirm={onConfirm}>Confirmar</DespachoGateButton>);
    const btn = screen.getByRole('button', { name: /confirmar/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('phone invalid: button disabled', () => {
    render(<DespachoGateButton gate={{ ...baseGate, telefonoValido: false }} onConfirm={vi.fn()}>Confirmar</DespachoGateButton>);
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
  });

  // ── Candado anti-doble-click ──────────────────────────────────────
  // Sin estas pruebas, borrar `disabled={marking}` en CallView (o dejar de
  // propagar `disabled` en la RAMA HABILITADA de este componente) deja toda la
  // suite en verde mientras se vuelve a despachar un pedido que nadie llamó:
  // la cola avanza ANTES del await de markResult, así que el segundo click cae
  // sobre el pedido SIGUIENTE. Era el hallazgo más grave de la auditoría y no
  // tenía ninguna red automatizada.

  it('disabled: no dispara onConfirm aunque el gate esté abierto', () => {
    const onConfirm = vi.fn();
    render(<DespachoGateButton gate={baseGate} onConfirm={onConfirm} disabled>Confirmar</DespachoGateButton>);
    const btn = screen.getByRole('button', { name: /confirmar/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disabled: un doble-click no produce ningún despacho', () => {
    const onConfirm = vi.fn();
    render(<DespachoGateButton gate={baseGate} onConfirm={onConfirm} disabled>Confirmar</DespachoGateButton>);
    const btn = screen.getByRole('button', { name: /confirmar/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disabled=false explícito: sigue confirmando (no rompe el camino normal)', () => {
    const onConfirm = vi.fn();
    render(<DespachoGateButton gate={baseGate} onConfirm={onConfirm} disabled={false}>Confirmar</DespachoGateButton>);
    const btn = screen.getByRole('button', { name: /confirmar/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
