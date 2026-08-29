import { describe, it, expect, vi, afterEach } from 'vitest';
import { copiarAlPortapapeles } from './portapapeles';

/**
 * El bug que motivó este archivo (28-ago-2026): el botón de copiar el número de
 * pedido estaba escrito `navigator.clipboard?.writeText(n).then(…).catch(…)`.
 * El `?.` corta la cadena ENTERA, así que sin `navigator.clipboard` no copiaba
 * NI avisaba — y el comentario de al lado afirmaba que sí avisaba.
 *
 * Estas pruebas fijan lo único que importa del contrato: **el booleano dice la
 * verdad**. Si devuelve `true`, copió; si no pudo, devuelve `false` y la
 * pantalla puede mostrar el número para transcribirlo.
 */

const conClipboard = (writeText: () => Promise<void>) => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText }, configurable: true, writable: true,
  });
};
const sinClipboard = () => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: undefined, configurable: true, writable: true,
  });
};

afterEach(() => {
  sinClipboard();
  // jsdom no implementa execCommand: se borra lo que haya puesto el test.
  delete (document as { execCommand?: unknown }).execCommand;
});

describe('copiarAlPortapapeles', () => {
  it('con la API moderna disponible, copia y lo dice', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    conClipboard(writeText);
    await expect(copiarAlPortapapeles('6637528')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('6637528');
  });

  it('⛔ SIN la API (contexto no seguro) NO se queda mudo: cae al fallback', async () => {
    sinClipboard();
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    await expect(copiarAlPortapapeles('6637528')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('si la API moderna RECHAZA (permiso, sin foco), reintenta por el fallback', async () => {
    conClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    document.execCommand = vi.fn().mockReturnValue(true);
    await expect(copiarAlPortapapeles('6637528')).resolves.toBe(true);
  });

  it('⛔ cuando NO se pudo copiar devuelve false — nunca finge éxito', async () => {
    sinClipboard();
    // Sin `execCommand` (el caso de jsdom y de navegadores que ya lo quitaron).
    await expect(copiarAlPortapapeles('6637528')).resolves.toBe(false);
  });

  it('el fallback que devuelve false se propaga como false', async () => {
    sinClipboard();
    document.execCommand = vi.fn().mockReturnValue(false);
    await expect(copiarAlPortapapeles('6637528')).resolves.toBe(false);
  });

  it('no deja basura en el DOM después de copiar', async () => {
    sinClipboard();
    document.execCommand = vi.fn().mockReturnValue(true);
    await copiarAlPortapapeles('6637528');
    expect(document.querySelectorAll('textarea').length).toBe(0);
  });

  it('texto vacío no intenta nada', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    conClipboard(writeText);
    await expect(copiarAlPortapapeles('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
