/**
 * Dominio CANÓNICO de Guardian para los links que salen por correo o WhatsApp.
 *
 * `window.location.origin` es el origen de QUIEN está mirando la pantalla. Si el
 * dueño abre un preview de Lovable, o localhost, el link que se manda apunta
 * ahí — y quien lo recibe no puede abrirlo. `VITE_PUBLIC_APP_URL` fija el
 * dominio real; el origen del navegador queda solo como último recurso.
 *
 * Ya vivía duplicado en StoreInvitePanel y CompartirGuardianPanel, y el alta de
 * cuenta (el link de confirmación del correo) no lo usaba en absoluto.
 */
export function appBaseUrl(): string {
  const configurado = (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined)?.trim();
  if (configurado) return configurado.replace(/\/+$/, '');
  return window.location.origin.replace(/\/+$/, '');
}

/** `appBaseUrl()` + una ruta. `ruta` puede venir con o sin `/` inicial. */
export function appUrl(ruta = ''): string {
  const r = ruta.replace(/^\/+/, '');
  return r ? `${appBaseUrl()}/${r}` : appBaseUrl();
}
