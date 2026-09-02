import "@testing-library/jest-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// ResizeObserver polyfill for recharts in jsdom (Task 13).
class ResizeObserverPolyfill {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverPolyfill;
}

// scrollIntoView no existe en jsdom. Cualquier componente que abra una lista
// "al final" —el hilo de WhatsApp, por ejemplo— la llama en un efecto y sin
// esto el render entero revienta con "is not a function": el test falla por el
// polyfill que falta, no por el componente.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
