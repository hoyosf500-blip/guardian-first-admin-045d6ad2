// Lectura HUMANA del resultado de verificar las credenciales Dropi de una tienda.
//
// POR QUÉ EXISTE
// Hasta el 6-ago-2026 el asistente de configuración guardaba y decía "Tienda
// configurada" en verde SIN probar una sola credencial. Un cliente podía
// terminar el setup con las tres mal y entrar a un CRM vacío creyendo que lo
// había hecho bien. Peor: el asistente le pedía el `dropi_session_token`
// —copiándolo del inspector de red del navegador— y NO le pedía email y clave,
// que es lo único que renueva ese token solo. O sea, pedía lo que se muere en
// una hora y no pedía lo que dura para siempre.
//
// Eso ya pasó de verdad: Colombia quedó configurada sin email ni clave y su
// billetera murió el 28-jul sin que nadie se enterara hasta el 6-ago.
//
// Esta capa es PURA a propósito: decide qué está roto, qué bloquea y qué se le
// dice al cliente, sin tocar red. Así se puede probar el camino del cliente
// nuevo sin tener una tienda nueva a mano — que es justamente el camino que el
// dueño no puede ejercitar en su propio navegador.

/** Las tres cosas que tienen que funcionar para que una tienda esté viva. */
export type ClaveChequeo = 'api_key' | 'login' | 'billetera';

/** Lo que devuelve la edge function por cada chequeo, sin interpretar. */
export interface ChequeoCrudo {
  clave: ClaveChequeo;
  ok: boolean;
  /** HTTP que devolvió Dropi. 0 = ni siquiera respondió (red/timeout). */
  httpStatus?: number;
  /** Mensaje textual de Dropi o del error. */
  mensaje?: string;
  /** Cuántos pedidos/filas se vieron. Sirve para distinguir "entró pero está
   *  vacío" de "entró y hay datos". */
  muestra?: number;
  /** true cuando el chequeo no se pudo correr porque falta un dato previo. */
  omitido?: boolean;
}

export type EstadoChequeo = 'ok' | 'falla' | 'aviso' | 'omitido';

export interface ChequeoLegible {
  clave: ClaveChequeo;
  estado: EstadoChequeo;
  titulo: string;
  detalle: string;
  /** Qué tiene que hacer el cliente. Vacío cuando no hay nada que hacer. */
  comoArreglar: string;
  /** Si esto falla, la tienda no sirve y no se puede continuar. */
  bloqueante: boolean;
}

const TITULOS: Record<ClaveChequeo, string> = {
  api_key: 'Leer tus pedidos',
  login: 'Entrar a tu cuenta',
  billetera: 'Bajar tu billetera',
};

/** Códigos que NO significan "credencial mala".
 *
 *  Esto importa más de lo que parece: si a un cliente cuya cuenta está
 *  momentáneamente frenada por Dropi le decimos "tu clave está mal", va a
 *  cambiar una clave que funcionaba. Un mensaje equivocado hace que alguien
 *  rompa algo que estaba bien. */
function esTransitorio(httpStatus?: number): boolean {
  return httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504;
}

function leerApiKey(c: ChequeoCrudo): ChequeoLegible {
  const base = { clave: 'api_key' as const, titulo: TITULOS.api_key, bloqueante: true };
  if (c.ok) {
    return {
      ...base,
      estado: 'ok',
      detalle: c.muestra && c.muestra > 0
        ? `Dropi respondió y ya vemos tus pedidos.`
        : `Dropi respondió correctamente. Todavía no hay pedidos en el rango de prueba, lo cual es normal en una cuenta nueva.`,
      comoArreglar: '',
    };
  }
  if (esTransitorio(c.httpStatus)) {
    return {
      ...base,
      estado: 'aviso',
      detalle: `Dropi está respondiendo lento o frenó las consultas (código ${c.httpStatus}). Esto no quiere decir que tu clave esté mal.`,
      comoArreglar: 'Esperá unos minutos y volvé a verificar. No cambies la clave por esto.',
    };
  }
  if (c.httpStatus === 401 || c.httpStatus === 403) {
    return {
      ...base,
      estado: 'falla',
      detalle: 'Dropi rechazó la API Key: no es válida para esta cuenta.',
      comoArreglar: 'Entrá a Dropi → Configuración → API y copiá la clave de integraciones completa, sin espacios ni comillas.',
    };
  }
  return {
    ...base,
    estado: 'falla',
    detalle: c.mensaje
      ? `No se pudo leer tus pedidos: ${c.mensaje}`
      : 'No se pudo leer tus pedidos.',
    comoArreglar: 'Revisá que la API Key esté completa y que el país de la tienda sea el correcto.',
  };
}

function leerLogin(c: ChequeoCrudo): ChequeoLegible {
  // NO bloqueante: sin login el CRM funciona igual (los pedidos entran con la
  // API Key). Lo que se muere es la billetera, y con ella los números de plata.
  // Por eso es un aviso fuerte y no un portón cerrado.
  const base = { clave: 'login' as const, titulo: TITULOS.login, bloqueante: false };
  if (c.omitido) {
    return {
      ...base,
      estado: 'aviso',
      detalle: 'No cargaste el correo y la clave de Dropi.',
      comoArreglar: 'Sin esto tu billetera deja de actualizarse en una hora y los costos quedan congelados. Cargalos arriba.',
    };
  }
  if (c.ok) {
    return {
      ...base,
      estado: 'ok',
      detalle: 'Entramos a tu cuenta de Dropi. Guardian va a renovar el acceso solo, sin que hagas nada.',
      comoArreglar: '',
    };
  }
  if (esTransitorio(c.httpStatus)) {
    return {
      ...base,
      estado: 'aviso',
      detalle: `Dropi no respondió al intento de entrar (código ${c.httpStatus}).`,
      comoArreglar: 'Esperá unos minutos y volvé a verificar.',
    };
  }
  // El caso que más veces vamos a ver en la vida real.
  const dosPasos = /2fa|dos pasos|verificaci/i.test(c.mensaje ?? '');
  return {
    ...base,
    estado: 'falla',
    detalle: dosPasos
      ? 'Tu cuenta de Dropi tiene verificación en dos pasos, y eso bloquea el acceso automático.'
      : 'Dropi rechazó el correo o la clave.',
    comoArreglar: dosPasos
      ? 'Desactivá la verificación en dos pasos en Dropi, o tu billetera va a quedar desactualizada.'
      : 'Revisá que sean exactamente los mismos con los que entrás a la página de Dropi.',
  };
}

function leerBilletera(c: ChequeoCrudo): ChequeoLegible {
  const base = { clave: 'billetera' as const, titulo: TITULOS.billetera, bloqueante: false };
  if (c.omitido) {
    // Sin login no tiene sentido gritar dos veces por la misma causa: el
    // cliente vería dos renglones rojos y creería que tiene dos problemas.
    return {
      ...base,
      estado: 'omitido',
      detalle: 'No se probó porque depende del acceso a tu cuenta.',
      comoArreglar: '',
    };
  }
  if (c.ok) {
    return {
      ...base,
      estado: 'ok',
      detalle: 'Tu billetera baja bien. Los costos de envío y devolución van a salir solos.',
      comoArreglar: '',
    };
  }
  if (esTransitorio(c.httpStatus)) {
    return {
      ...base,
      estado: 'aviso',
      detalle: `Dropi frenó la descarga (código ${c.httpStatus}).`,
      comoArreglar: 'Esperá unos minutos y volvé a verificar.',
    };
  }
  return {
    ...base,
    estado: 'aviso',
    detalle: c.mensaje ? `No se pudo bajar la billetera: ${c.mensaje}` : 'No se pudo bajar la billetera.',
    comoArreglar: 'Los pedidos van a funcionar igual, pero los números de costos van a quedar en cero hasta que esto entre.',
  };
}

const LECTORES: Record<ClaveChequeo, (c: ChequeoCrudo) => ChequeoLegible> = {
  api_key: leerApiKey,
  login: leerLogin,
  billetera: leerBilletera,
};

/** Orden fijo: es el orden en que las cosas dependen unas de otras, y por lo
 *  tanto el orden en que el cliente las tiene que arreglar. */
export const ORDEN_CHEQUEOS: ClaveChequeo[] = ['api_key', 'login', 'billetera'];

export function interpretarChequeos(crudos: ChequeoCrudo[]): ChequeoLegible[] {
  const porClave = new Map(crudos.map((c) => [c.clave, c]));
  return ORDEN_CHEQUEOS.map((clave) => {
    const c = porClave.get(clave) ?? { clave, ok: false, omitido: true };
    return LECTORES[clave](c);
  });
}

/** ¿Puede entrar al CRM? Solo lo impide que no podamos leer sus pedidos: sin
 *  eso el CRM está literalmente vacío y no hay nada que mostrarle. */
export function puedeContinuar(chequeos: ChequeoLegible[]): boolean {
  return !chequeos.some((c) => c.bloqueante && c.estado === 'falla');
}

/** ¿Está TODO bien? Es lo único que habilita a decir "listo" sin asteriscos.
 *  Un 'aviso' no cuenta: fue exactamente esa indulgencia la que dejó a
 *  Colombia dos meses con la billetera muerta y el cartel en verde. */
export function estaCompleto(chequeos: ChequeoLegible[]): boolean {
  return chequeos.every((c) => c.estado === 'ok');
}

/** Frase de cierre. Nunca dice "listo" si no lo está. */
export function resumen(chequeos: ChequeoLegible[]): string {
  if (estaCompleto(chequeos)) return 'Todo conectado y verificado.';
  const fallas = chequeos.filter((c) => c.estado === 'falla');
  if (fallas.some((c) => c.bloqueante)) {
    return 'Falta resolver algo importante antes de poder usar Guardian.';
  }
  const pendientes = chequeos.filter((c) => c.estado === 'falla' || c.estado === 'aviso');
  return `Podés entrar, pero quedan ${pendientes.length} cosa(s) sin resolver.`;
}
