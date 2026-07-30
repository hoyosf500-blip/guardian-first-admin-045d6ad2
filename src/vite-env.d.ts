/// <reference types="vite/client" />

/** Sello del build, inyectado por vite.config.ts (`define`). Lo reporta cada
 *  sesión para que el panel /plataforma detecte navegadores con versión vieja. */
declare const __APP_VERSION__: string;
