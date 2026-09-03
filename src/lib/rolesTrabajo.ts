// src/lib/rolesTrabajo.ts
//
// QUIÉN TRABAJA LA COLA Y QUIÉN SOLO LA MIRA. Una sola definición.
//
// ── Por qué existe (pedido del dueño, 28-ago-2026) ──────────────────────────
// Textual: *"el supervisor también trabaja, solo es un rango más que el
// operador, así que lo que él haga tenerlo en cuenta. Yo que soy el dueño solo
// veo pero no hago nada, así que si entro a un pedido no se me debe contar —
// solo estoy viendo que todo esté marchando bien."*
//
// Dos frases, dos reglas:
//   1. **El supervisor es un asesor más.** Se le mide y se le cuenta igual.
//   2. **El dueño es un observador.** Entrar a un pedido tiene que costar CERO:
//      ni lo reclama, ni lo esconde, ni le ficha jornada, ni lo cuenta.
//
// ── Por qué hacía falta un archivo entero para esto ─────────────────────────
// Guardian tenía TRES definiciones distintas de "el que trabaja", conviviendo:
//
//   A. `!isAdmin && !isOwnerOfActive` — supervisor SÍ trabaja.
//      (`useOperatorHeartbeat`, `useSegAssignment`, `SegCounterBar`, el roster
//      del reparto.) Es la correcta.
//   B. `!isAdmin && !isManagerOfActive` — supervisor NO trabaja.
//      (`useInactivityGuard`, `InactivityGuard`.) `isManagerOfActive` es
//      «dueño O supervisor», así que usarlo como reja de trabajadores mete al
//      supervisor del lado de los jefes. Roberto —el que de verdad trabaja la
//      cola de Ecuador— quedaba fuera del aviso por huecos y sin el botón
//      «Estoy en otra cosa» para explicar una ida a la agencia.
//   C. Ninguna reja. (`CallView`.) Y ahí estaba el caro: ver un pedido lo
//      RECLAMA con `claim_order`, y `isLockedByOther` lo esconde de la cola de
//      TODAS las asesoras por 15 minutos. O sea: el dueño entraba a mirar si
//      todo iba bien y le quitaba el cliente al equipo. Es el mismo daño que
//      ya se corrigió en Seguimiento en agosto-2026 («un dueño nuevo que abría
//      Seguimiento se auto-asignaba los pedidos de sus operadoras»), pero
//      Confirmar nunca se tocó.
//
// Tres copias de un mismo hecho es exactamente lo que este proyecto ya pagó con
// el contador clavado en 222 y con el hero diciendo «9 de 32» y «21 de 32» a la
// vez. De acá en adelante, una.

/** Los dos flags de rol que hacen falta. `isAdmin` es el admin GLOBAL de la
 *  plataforma (`user_roles`); `isOwnerOfActive` es el dueño de la tienda activa
 *  (`store_members`). Son las dos capas independientes de `AuthContext` y
 *  `StoreContext` — no se mezclan, se reciben las dos. */
export interface RolEnLaTienda {
  isAdmin: boolean;
  isOwnerOfActive: boolean;
}

/**
 * Trabaja la cola y por lo tanto SE LE MIDE: operadora **y supervisor**.
 *
 * Es el universo de: reparto de la cola, jornada (heartbeat), reclamo de
 * pedidos, aviso por huecos sin gestionar y botón de pausa.
 */
export function trabajaLaCola(r: RolEnLaTienda): boolean {
  return !r.isAdmin && !r.isOwnerOfActive;
}

/**
 * Mira, no hace: admin global y dueño de la tienda.
 *
 * Para éste, **abrir un pedido no puede tener NINGÚN efecto**: no lo reclama,
 * no lo esconde de nadie, no le ficha jornada y no lo cuenta como gestión. Si
 * mañana aparece una acción nueva que se dispara al abrir un pedido, la reja va
 * acá.
 */
export function soloObserva(r: RolEnLaTienda): boolean {
  return !trabajaLaCola(r);
}

/**
 * A quién puede TRABARLE la pantalla el guard de inactividad (el 3er aviso
 * bloquea 5 minutos reales).
 *
 * ── El supervisor SÍ se traba (decisión del dueño, 3-sep-2026) ──────────────
 * Hasta hoy esta función era MÁS ESTRECHA que `trabajaLaCola`: excluía al
 * supervisor con este argumento, que era real y hay que dejar escrito porque
 * sigue siendo el riesgo de este cambio —
 *
 *   *"trabarle la pantalla cinco minutos deja al equipo sin la persona que lo
 *   destraba: es el que llama a la transportadora, el que resuelve la novedad
 *   rara y el que reparte la cola."*
 *
 * El dueño lo revirtió a conciencia, con un caso concreto encima de la mesa: el
 * supervisor manda plantillas con el botón de un clic, hace UN intento y no
 * vuelve a mirar si contestaron. Textual: *"a los supervisores también se les
 * cuenta porque trabajan menos; al supervisor también se le muestran las
 * alertas"*. Un aviso que no traba a quien menos rinde no es un aviso, es un
 * adorno — y el rango no puede ser el motivo de estar exento.
 *
 * ⛔ NO se borró el argumento viejo: sigue arriba porque es el costo que se
 * aceptó, no un error que se corrigió. Si mañana el equipo queda esperando a un
 * supervisor trabado, ésta es la línea que hay que discutir — con el dato de
 * cuántas veces pasó, no de memoria.
 *
 * Queda con nombre propio y con el mismo parámetro aunque hoy no lo mire: el
 * concepto "a quién se le traba" es distinto de "a quién se le mide", y el día
 * que se vuelvan a separar, se separan acá y en ningún otro lado.
 */
export function seLeBloqueaLaPantalla(
  r: RolEnLaTienda & { isManagerOfActive: boolean },
): boolean {
  return trabajaLaCola(r);
}
