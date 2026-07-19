// TEMA ÚNICO OSCURO (decisión del dueño, 2026-07-18).
//
// El CRM maneja un solo color. Antes había toggle claro/oscuro y el tema se
// resolvía en un `useEffect`, o sea DESPUÉS del primer pintado: el navegador
// mostraba `:root` (claro) durante unos ms y recién ahí llegaba la clase.
// Eso era el "fondo blanco" que se veía en cada carga y cada F5.
//
// Ahora la clase `dark` viaja en el HTML estático (`index.html`), así que el
// primer pixel ya sale oscuro y no hay destello posible.
//
// Este hook queda como red de seguridad: si algo (una extensión, un
// localStorage viejo, un experimento) le saca la clase al <html>, se la
// devuelve. NO expone `toggleTheme` a propósito — si volviera a existir un
// toggle, volvería el destello y volvería el tema claro que ya no se usa.
//
// Los tokens del tema claro siguen en `index.css` y sus tests de contraste
// siguen corriendo: quedan inertes, no borrados, para que reactivar el tema
// claro sea un commit y no una arqueología.
import { useEffect } from 'react';

export function useTheme() {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains('dark')) {
      root.classList.remove('light');
      root.classList.add('dark');
    }
  }, []);

  return { theme: 'dark' as const };
}
