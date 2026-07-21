import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductoTile } from './ProductoTile';

/**
 * Payloads REALES de producción (2026-07-21). Si la ficha deja de mostrar la
 * talla, la asesora despacha el par equivocado y el pedido vuelve devuelto.
 */
describe('ProductoTile', () => {
  it('un par: muestra nombre, color, talla y precio', () => {
    render(
      <ProductoTile
        producto="Nuevo modelo Sneakers 2801"
        lineas={[{ nombre: 'Nuevo modelo Sneakers 2801', variante: 'AZUL / 37', cantidad: 1, precio: 109900 }]}
      />,
    );
    expect(screen.getByText('Nuevo modelo Sneakers 2801')).toBeInTheDocument();
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.getByText('AZUL')).toBeInTheDocument();
    expect(screen.getByText('Talla')).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument();
  });

  it('dos pares distintos: cada línea con SU talla (el bug original)', () => {
    render(
      <ProductoTile
        producto="Nuevo modelo Sneakers 2801"
        lineas={[
          { nombre: 'Nuevo modelo Sneakers 2801', variante: 'GRIS / 38', cantidad: 1, precio: 84950 },
          { nombre: 'Nuevo modelo Sneakers 2801', variante: 'NEGRO X BLANCO / 37', cantidad: 1, precio: 84950 },
        ]}
      />,
    );
    expect(screen.getByText('GRIS')).toBeInTheDocument();
    expect(screen.getByText('38')).toBeInTheDocument();
    expect(screen.getByText('NEGRO X BLANCO')).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('muestra la cantidad sólo cuando es más de uno', () => {
    const { rerender } = render(
      <ProductoTile lineas={[{ nombre: 'X', variante: 'AZUL / 37', cantidad: 1, precio: 100 }]} />,
    );
    expect(screen.queryByText('Cantidad')).not.toBeInTheDocument();

    rerender(<ProductoTile lineas={[{ nombre: 'X', variante: 'AZUL / 37', cantidad: 3, precio: 100 }]} />);
    expect(screen.getByText('Cantidad')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('pedido sin detalle (todavía no re-sincronizado): cae al texto de siempre', () => {
    render(<ProductoTile producto="Reparador Esmalte Dental" lineas={[]} cantidad={2} />);
    expect(screen.getByText('Reparador Esmalte Dental × 2')).toBeInTheDocument();
  });

  it('sin producto ni detalle no rompe la ficha', () => {
    render(<ProductoTile />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
