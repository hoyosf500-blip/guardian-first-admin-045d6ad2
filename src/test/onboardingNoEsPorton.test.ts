import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * El asistente de Dropi es una AYUDA, no un portón (decisión del dueño,
 * 2026-08-13: "que cuando se registren los deje entrar a Guardian y adentro
 * poder configurar lo que haga falta").
 *
 * Antes, una tienda sin `dropi_api_key` no mostraba la app: `ProtectedLayout`
 * devolvía el asistente a pantalla completa en lugar del layout. Y en la
 * pantalla de resultado el botón de salida iba detrás de `puede`, así que ante
 * una falla bloqueante no se dibujaba NINGUNA salida. En el recorrido real del
 * 2026-08-13 eso pasaba hasta con la API Key correcta (faltaba el header
 * `Origin` en la verificación): el amigo quedaba encerrado en la primera
 * pantalla de Guardian, que es el peor lugar posible para un callejón.
 *
 * Estas guardias son de FUENTE porque el camino solo se ejerce con una tienda
 * recién creada y sin credenciales — no es un estado que el dueño pueda
 * reproducir en su navegador.
 */

const layout = readFileSync('src/components/ProtectedLayout.tsx', 'utf8');
const wizard = readFileSync('src/components/SetupWizard.tsx', 'utf8');

describe('el asistente de Dropi no vuelve a ser un portón', () => {
  it('ProtectedLayout NO reemplaza la app cuando falta la credencial', () => {
    // La condición vieja. Si reaparece, el CRM entero vuelve a desaparecer.
    expect(layout).not.toMatch(/if\s*\(\s*store\.needsSetup\s*\|\|\s*wizardOpen\s*\)/);
    // El asistente se muestra SOLO mientras está abierto, y se cierra desde adentro.
    expect(layout).toMatch(/if\s*\(\s*wizardOpen\s*\)/);
  });

  it('sin credenciales se entra igual, con un aviso que llama a configurar', () => {
    expect(layout).toContain('ConectarDropiBanner');
    expect(layout).toMatch(/store\.needsSetup\s*&&\s*<ConectarDropiBanner/);
  });

  it('el asistente ofrece entrar a Guardian sin terminarlo', () => {
    expect(wizard).toContain('onLater');
    expect(wizard).toMatch(/Entrar a Guardian y configurar esto después/);
  });

  it('la pantalla de resultado SIEMPRE tiene salida, también con falla bloqueante', () => {
    // El encierro concreto: la salida envuelta en `puede &&`.
    expect(wizard).not.toMatch(/puede\s*&&\s*\(\s*<button/);
    expect(wizard).toMatch(/onClick=\{onSalirIgual\}/);
  });
});
