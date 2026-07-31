import { describe, it, expect } from 'vitest';
import { esTeclaDeAtajo } from './hotkeys';

// `hotkeysHabilitados` se testea contra overlays REALES de Radix en
// src/components/CallView.hotkeys.test.tsx (necesita DOM montado). Acá va la
// otra mitad del guard, que es pura.
describe('esTeclaDeAtajo', () => {
  const ev = (over: Partial<KeyboardEvent>) =>
    ({ ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...over }) as KeyboardEvent;

  it('deja pasar una tecla suelta', () => {
    expect(esTeclaDeAtajo(ev({ key: 'ArrowRight' }))).toBe(true);
    expect(esTeclaDeAtajo(ev({ key: 'l' }))).toBe(true);
  });

  it('NO le roba los aceleradores al navegador', () => {
    // Ctrl+L es la barra de direcciones; Cmd+W cierra la pestaña. Si el atajo
    // se los queda, la asesora pierde el control de su propio navegador.
    expect(esTeclaDeAtajo(ev({ key: 'l', ctrlKey: true }))).toBe(false);
    expect(esTeclaDeAtajo(ev({ key: 'w', metaKey: true }))).toBe(false);
    expect(esTeclaDeAtajo(ev({ key: 'ArrowRight', altKey: true }))).toBe(false);
  });

  it('ignora la repetición por tecla sostenida', () => {
    // Un dedo trabado en → recorrería la carpeta entera en un segundo.
    expect(esTeclaDeAtajo(ev({ key: 'ArrowRight', repeat: true }))).toBe(false);
  });
});
