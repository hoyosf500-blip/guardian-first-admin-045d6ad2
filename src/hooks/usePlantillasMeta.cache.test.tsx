import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * GUARDIÁN de velocidad (28-ago-2026).
 *
 * El dueño reportó: *"abrir chat y enviar plantillas está lento, el CRM lo
 * siento pesado, mi equipo se está desesperando"*.
 *
 * Una de las causas, encontrada leyendo la edge: `importchat-plantillas` con
 * `accion:'listar'` devuelve SIEMPRE la misma lista y lo único que hace con
 * `fase` es **ordenarla** (`ordenarParaFase`, que es pura y ya vive en el
 * cliente). El caché del hook era por `(tienda, fase)`, así que el tablero
 * pedía las MISMAS 43 plantillas una vez por cada fase — quince viajes a
 * ImporChat — y la asesora esperaba en cada fase nueva que tocaba.
 *
 * Este test falla si alguien vuelve a meter la fase en la clave del caché o en
 * el cuerpo de la petición.
 *
 * Stub de red INLINE, no un mock global del cliente de Supabase (la regla de la
 * casa): acá lo que se mide es cuántas veces se llama, no qué contesta.
 */

const invoke = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

let storeId: string | null = 'tienda-1';
vi.mock('@/contexts/StoreContext', () => ({
  useStore: () => ({ activeStoreId: storeId }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));

const PLANTILLAS = [
  { nombre: 'retiro_agencia_v1', cuerpo: 'Hola {{1}}', categoria: 'UTILITY', idioma: 'es' },
  { nombre: 'novedad_k1', cuerpo: 'Su pedido {{1}}', categoria: 'UTILITY', idioma: 'es' },
  { nombre: 'plantilla_de_prueba', cuerpo: 'test', categoria: 'MARKETING', idioma: 'es' },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true, plantillas: PLANTILLAS }, error: null });
});

describe('las plantillas se piden UNA vez por tienda, no una por fase', () => {
  it('⛔ cuatro fases distintas = UNA sola llamada a ImporChat', async () => {
    const { usePlantillasMeta } = await import('./usePlantillasMeta');
    for (const fase of ['oficina', 'novedad', 'reparto', 'guia']) {
      const { result } = renderHook(() => usePlantillasMeta(true, fase));
      await waitFor(() => expect(result.current.estado).toBe('ok'));
      expect(result.current.plantillas.length).toBe(PLANTILLAS.length);
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('⛔ la petición NO lleva `fase`: el orden se calcula en el cliente', async () => {
    const { precargarPlantillas } = await import('./usePlantillasMeta');
    storeId = 'tienda-sin-fase';
    precargarPlantillas(storeId);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const cuerpo = invoke.mock.calls[0][1] as { body?: Record<string, unknown> };
    expect(cuerpo.body).not.toHaveProperty('fase');
    storeId = 'tienda-1';
  });

  it('cada fase recibe SU orden aunque la lista venga de la misma llamada', async () => {
    const { usePlantillasMeta } = await import('./usePlantillasMeta');
    storeId = 'tienda-orden';
    const of = renderHook(() => usePlantillasMeta(true, 'oficina'));
    await waitFor(() => expect(of.result.current.estado).toBe('ok'));
    const nov = renderHook(() => usePlantillasMeta(true, 'novedad'));
    await waitFor(() => expect(nov.result.current.estado).toBe('ok'));

    expect(of.result.current.plantillas[0].nombre).toBe('retiro_agencia_v1');
    expect(nov.result.current.plantillas[0].nombre).toBe('novedad_k1');
    // Y las de prueba al fondo en las dos, como siempre.
    expect(of.result.current.plantillas.at(-1)?.nombre).toBe('plantilla_de_prueba');
    expect(invoke).toHaveBeenCalledTimes(1);
    storeId = 'tienda-1';
  });

  it('precargar y abrir a la vez NO dispara dos llamadas', async () => {
    // La asesora puede tocar el botón antes de que llegue la precarga: sin el
    // vuelo compartido eran dos viajes para la misma lista.
    const { usePlantillasMeta, precargarPlantillas } = await import('./usePlantillasMeta');
    storeId = 'tienda-carrera';
    precargarPlantillas(storeId);
    const { result } = renderHook(() => usePlantillasMeta(true, 'oficina'));
    await waitFor(() => expect(result.current.estado).toBe('ok'));
    expect(invoke).toHaveBeenCalledTimes(1);
    storeId = 'tienda-1';
  });
});
