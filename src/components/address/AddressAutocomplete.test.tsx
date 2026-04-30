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
});
