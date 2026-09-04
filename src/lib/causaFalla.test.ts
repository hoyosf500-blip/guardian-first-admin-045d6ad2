import { describe, it, expect } from 'vitest';
import { causaDeFalla } from './causaFalla';

/**
 * Los mensajes son LITERALES de producción, copiados de `shopify_pushed_orders`
 * de Ecuador (medición del 28-ago al 4-sep-2026, 480 ventas intentadas, 85 sin
 * llegar). No son inventados: si Dropi cambia la redacción, esta prueba se pone
 * roja y avisa que la agrupación dejó de servir — que es exactamente lo que
 * queremos que pase.
 */
const REALES = {
  stock: 'Fallback web [422]: El producto Dropi 147152 no tiene stock en bodega (sin ciudad de origen).',
  cobertura: 'Fallback web [422]: Dropi no lista "RIO VERDE (ESMERALDAS)" en su catálogo de envíos — sin cobertura COD para cotizar/editar este destino. Confirmá la ciudad con el cliente (puede recibir en un cantón cercano con cobertura) o gestioná el pedido directo en el panel de Dropi.',
  metodo: 'Fallback web [502]: Dropi (panel web) rechazó el pedido [200]: 3. La ciudad no tiene habilitado el médoto de envío: CON RECAUDO - SAN CRISTOBAL-GALAPAGOS-SERVIENTREGA-[]-',
  variable: 'Fallback web [502]: Dropi (panel web) rechazó el pedido [200]: El producto Shampoo Cubre Canas Dexe Argan es variable, por lo tanto debe indicar una variación',
  ciudadDepto: 'Dropi [200]: 3: La ciudad no existe en el departamento ingresado, por favor corregir. CIUDAD: GENERAL VILLAMIL (PLAYAS) - DEPARTAMENTO: GUAYAS',
  cotizar: 'Fallback web [502]: Dropi (panel web) rechazó el pedido [200]: No se ha podido cotizar el valor del envio:Operation timed out',
};

describe('causaDeFalla — los seis motivos medidos en producción', () => {
  it('producto sin stock: la clave lleva el id, porque UN producto frenó 40 ventas', () => {
    const c = causaDeFalla(REALES.stock);
    expect(c.familia).toBe('sin_stock');
    expect(c.clave).toBe('sin_stock:147152');
    expect(c.etiqueta).toContain('147152');
    expect(c.loArreglaElDueno, 'reintentar solo no repone el stock').toBe(true);
    expect(c.via).toBe('web');
  });

  it('sin cobertura: la clave lleva la ciudad', () => {
    const c = causaDeFalla(REALES.cobertura);
    expect(c.familia).toBe('sin_cobertura');
    expect(c.clave).toBe('sin_cobertura:RIO VERDE (ESMERALDAS)');
    expect(c.etiqueta).toContain('RIO VERDE');
  });

  it('sin método de envío: saca la ciudad de la ruta que manda Dropi', () => {
    const c = causaDeFalla(REALES.metodo);
    expect(c.familia).toBe('sin_metodo_envio');
    expect(c.clave).toBe('sin_metodo:SAN CRISTOBAL');
    expect(c.etiqueta).toContain('SAN CRISTOBAL');
  });

  it('producto variable sin variación', () => {
    const c = causaDeFalla(REALES.variable);
    expect(c.familia).toBe('variable_sin_variacion');
    expect(c.clave).toContain('variable:');
    expect(c.etiqueta).toMatch(/variante/i);
  });

  it('ciudad que no coincide con su provincia', () => {
    const c = causaDeFalla(REALES.ciudadDepto);
    expect(c.familia).toBe('ciudad_no_coincide');
    expect(c.via, 'este vino por el endpoint de integraciones, no por la web').toBe('integraciones');
    expect(c.etiqueta).toContain('GENERAL VILLAMIL');
  });

  it('ninguna transportadora cotizó', () => {
    expect(causaDeFalla(REALES.cotizar).familia).toBe('sin_cotizacion');
  });
});

describe('causaDeFalla — cómo agrupa', () => {
  it('dos ventas del MISMO producto sin stock caen en la misma clave', () => {
    const a = causaDeFalla(REALES.stock);
    const b = causaDeFalla('Fallback web [422]: El producto Dropi 147152 no tiene stock en bodega (sin ciudad de origen).');
    expect(a.clave).toBe(b.clave);
  });

  it('dos productos DISTINTOS sin stock NO se mezclan', () => {
    const a = causaDeFalla(REALES.stock);
    const b = causaDeFalla('Fallback web [422]: El producto Dropi 5162 no tiene stock en bodega (sin ciudad de origen).');
    expect(a.clave).not.toBe(b.clave);
  });

  it('dos ciudades distintas sin cobertura NO se mezclan (pausar una no puede pausar la otra)', () => {
    const a = causaDeFalla(REALES.cobertura);
    const b = causaDeFalla('Fallback web [422]: Dropi no lista "TARAPOA (SUCUMBIOS)" en su catálogo de envíos — sin cobertura COD para cotizar/editar este destino.');
    expect(a.clave).not.toBe(b.clave);
  });
});

describe('causaDeFalla — lo que NO es una venta trabada', () => {
  it('el candado anti-duplicado cediendo no es una falla', () => {
    const c = causaDeFalla('Ya hay un pedido en Dropi con este teléfono: #6854946 (PENDIENTE). Si es una recompra real, subilo con "No es duplicado".');
    expect(c.familia, 'contar el candado como venta trabada sería mentir: hizo su trabajo').toBe('duplicado');
  });

  it('lo indeterminado NO se reintenta solo: puede haberse creado igual', () => {
    const c = causaDeFalla('needs_verify: no sé si la orden quedó creada en Dropi');
    expect(c.familia).toBe('sin_verificar');
    expect(c.comoSeArregla).toMatch(/antes de reintentar/i);
  });

  it('sin mensaje no se inventa un motivo', () => {
    expect(causaDeFalla(null).familia).toBe('sin_verificar');
    expect(causaDeFalla('').familia).toBe('sin_verificar');
  });
});

describe('causaDeFalla — lo desconocido no revienta ni se pierde', () => {
  it('un motivo nuevo se muestra tal cual y se agrupa por sus primeras palabras', () => {
    const c = causaDeFalla('Fallback web [500]: Se cayó el mundo entero por un motivo nunca visto');
    expect(c.familia).toBe('otro');
    expect(c.etiqueta).toContain('Se cayó el mundo entero');
    // Dos veces el mismo error desconocido son UN problema, no dos.
    const d = causaDeFalla('Fallback web [500]: Se cayó el mundo entero por un motivo nunca visto');
    expect(c.clave).toBe(d.clave);
  });
});
