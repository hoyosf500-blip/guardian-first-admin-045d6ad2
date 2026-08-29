// src/lib/vueloCompartido.ts
//
// Un dato que piden VARIOS a la vez se trae UNA sola vez.
//
// ── Por qué existe (medido en producción, 29-ago-2026) ──────────────────────
// `useSegTouchIndex` lo montan a la vez tres componentes —`SeguimientoTab`,
// `SiguienteAccionBar` (vive en el layout) e `InactivityGuard`— y cada
// instancia hacía SU propio barrido de 90 días de `touchpoints`. Como ese
// barrido se pagina de a 1.000 filas, eran **6 peticiones para el mismo dato**,
// compitiendo entre ellas por el mismo pool. Se vio en el cronómetro: tres
// consultas idénticas separadas por milisegundos (`…42.536Z`, `…42.539Z`,
// `…44.584Z`).
//
// Y el costo no era solo el viaje: la tercera copia aterrizaba ~2,5 s tarde,
// cambiaba la cola visible y **volvía a disparar `useRiesgoChat` entero**
// (otros cuatro viajes). Una lectura de más arrastraba otras cuatro.
//
// ── Las dos reglas que hacen que esto no mienta ─────────────────────────────
//  1. **El fallo NO se cachea.** Guardar un resultado roto es afirmar durante
//     todo el TTL algo que nunca se pudo leer — y en este caso concreto sería
//     "nadie cerró nada", que es justo lo que saca de la cola los pedidos ya
//     resueltos. Un error deja el caché limpio y el próximo montaje reintenta.
//  2. **TTL corto.** Alcanza para agrupar el montaje simultáneo y las
//     navegaciones entre pantallas; no para quedarse con una foto vieja.
//
// Puro: sin red, sin React. Recibe el cargador y devuelve la promesa.

export interface VueloCompartido<T> {
  /**
   * Devuelve el dato de `clave`. Si ya hay un vuelo en curso (o uno reciente
   * dentro del TTL) devuelve ESE, sin volver a llamar a `cargar`.
   *
   * `cargar` devuelve `{ valor, ok }`: con `ok:false` el valor se entrega igual
   * a quien esté esperando, pero NO queda cacheado.
   */
  pedir(
    clave: string,
    cargar: () => Promise<{ valor: T; ok: boolean }>,
    alFallar: () => T,
  ): Promise<T>;
  /** Vacía el caché. Para las pruebas y para un reset explícito. */
  limpiar(): void;
}

export function crearVueloCompartido<T>(ttlMs: number): VueloCompartido<T> {
  const cache = new Map<string, { at: number; p: Promise<T> }>();
  return {
    pedir(clave, cargar, alFallar) {
      const prev = cache.get(clave);
      if (prev && Date.now() - prev.at < ttlMs) return prev.p;
      const p = cargar()
        .then(({ valor, ok }) => {
          if (!ok) cache.delete(clave);
          return valor;
        })
        .catch((e) => {
          cache.delete(clave);
          console.warn('[vueloCompartido] la carga falló entera:', e);
          return alFallar();
        });
      cache.set(clave, { at: Date.now(), p });
      return p;
    },
    limpiar() {
      cache.clear();
    },
  };
}
