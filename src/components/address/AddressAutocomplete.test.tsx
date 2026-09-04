import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddressAutocomplete } from './AddressAutocomplete';

vi.mock('@/hooks/useGooglePlaces', () => ({
  useGooglePlaces: () => ({
    available: true,
    autocomplete: vi.fn().mockResolvedValue([
      { place_id: 'p1', description: 'Calle 8 #5-67, Bogotá', structured_formatting: { main_text: 'Calle 8 #5-67', secondary_text: 'Bogotá' } },
    ]),
    getDetails: vi.fn().mockResolvedValue({
      place_id: 'p1',
      formatted_address: 'Calle 8 #5-67, Bogotá, Colombia',
      geometry: { location: { lat: () => 4.601, lng: () => -74.062 } },
      address_components: [{ long_name: 'Bogotá', short_name: 'Bogotá', types: ['locality'] }],
    }),
  }),
}));

vi.mock('@/hooks/useAddressAutocompleteCache', () => ({
  lookupAutocompleteCache: vi.fn().mockResolvedValue(null),
  storeAutocompleteCache: vi.fn().mockResolvedValue(undefined),
  lookupRecurrentCustomer: vi.fn().mockResolvedValue(null),
}));

describe('AddressAutocomplete', () => {
  it('renderiza input con value inicial', () => {
    render(<AddressAutocomplete value="texto inicial" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('texto inicial')).toBeInTheDocument();
  });

  it('al tipear muestra sugerencias después de debounce', async () => {
    render(<AddressAutocomplete value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Calle 8' } });
    await waitFor(() => expect(screen.getByText(/Calle 8 #5-67/)).toBeInTheDocument(), { timeout: 1000 });
  });

  it('click en sugerencia llama onChange con datos completos', async () => {
    const onChange = vi.fn();
    render(<AddressAutocomplete value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Calle 8' } });
    await waitFor(() => screen.getByText(/Calle 8 #5-67/), { timeout: 1000 });
    fireEvent.click(screen.getByText(/Calle 8 #5-67/));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
        direccion: 'Calle 8 #5-67, Bogotá, Colombia',
        place_id: 'p1',
        lat: 4.601,
        lng: -74.062,
        source: 'autocomplete',
      }));
    });
  });

  it('muestra opción "escribir libre"', async () => {
    render(<AddressAutocomplete value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Calle 8' } });
    await waitFor(() => expect(screen.getByText(/escribir libre/i)).toBeInTheDocument(), { timeout: 1000 });
  });

  it('sin commitDelayMs avisa EN CADA TECLA (lo que necesita el formulario controlado del editor)', () => {
    const onChange = vi.fn();
    render(<AddressAutocomplete value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ca' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cal' } });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ direccion: 'Cal', source: 'free_write' }));
  });
});

/**
 * Modo diferido (`commitDelayMs`): lo usa la ficha de Confirmar porque cada
 * aviso es un UPDATE en `orders` + un viaje a Dropi. Estas pruebas fijan el
 * contrato: nada por tecla, UNA vez al quedarse quieto, en el acto al salir del
 * campo, y el eco del propio guardado no pisa lo que se sigue escribiendo.
 */
describe('AddressAutocomplete · commitDelayMs (guardado diferido)', () => {
  it('no avisa por tecla; avisa UNA vez con el texto final al quedarse quieto', async () => {
    const onChange = vi.fn();
    render(<AddressAutocomplete value="" onChange={onChange} commitDelayMs={80} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Calle 8' } });
    fireEvent.change(input, { target: { value: 'Calle 8 #5' } });
    fireEvent.change(input, { target: { value: 'Calle 8 #5-67' } });
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ direccion: 'Calle 8 #5-67', source: 'free_write' }));
  });

  it('al salir del campo (blur) avisa en el acto, y no repite al vencer el timer', async () => {
    const onChange = vi.fn();
    render(<AddressAutocomplete value="" onChange={onChange} commitDelayMs={80} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Av. Amazonas N24' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ direccion: 'Av. Amazonas N24' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('el ECO del valor ya avisado no pisa lo que la asesora sigue escribiendo', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<AddressAutocomplete value="" onChange={onChange} commitDelayMs={80} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Calle 8' } });
    fireEvent.blur(input); // avisa "Calle 8"
    fireEvent.change(input, { target: { value: 'Calle 8 #5' } }); // sigue escribiendo (pendiente)
    // El UPDATE de "Calle 8" volvió por realtime: el padre re-renderiza con ese valor.
    rerender(<AddressAutocomplete value="Calle 8" onChange={onChange} commitDelayMs={80} />);
    expect(input.value).toBe('Calle 8 #5');
    // Un valor DISTINTO del que se avisó (otro pedido, corrección externa) sí se refleja.
    rerender(<AddressAutocomplete value="Otra dirección" onChange={onChange} commitDelayMs={80} />);
    expect(input.value).toBe('Otra dirección');
  });

  it('al desmontarse con texto sin avisar, lo avisa (la asesora pasó al siguiente pedido)', () => {
    const onChange = vi.fn();
    const { unmount } = render(<AddressAutocomplete value="" onChange={onChange} commitDelayMs={80} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cra 15 #100-20' } });
    expect(onChange).not.toHaveBeenCalled();
    unmount();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ direccion: 'Cra 15 #100-20' }));
  });
});
