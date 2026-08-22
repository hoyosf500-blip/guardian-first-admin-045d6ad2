// supabase/functions/_shared/resumenDiario.ts
//
// El resumen del día que le llega al dueño por correo.
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// Guardian no tenía NINGUNA vía de aviso saliente: cero correo, cero
// mensajería. Si nadie abría la pantalla, nadie se enteraba de nada — y el
// dueño pidió justamente "que el colaborador sepa qué hacer sin yo estar
// encima". Eso solo funciona si él se entera sin tener que ir a mirar.
//
// ── La decisión de contenido ────────────────────────────────────────────────
// El resumen cuenta DOS cosas y las mantiene separadas a propósito:
//
//   1. **Lo que el equipo declaró** — los cierres de `seg_cierres`: cuánto
//      había, cuánto se gestionó y, si quedó algo, por qué. Es la palabra de
//      quien trabajó.
//   2. **Lo que la base sabe sola** — novedades abiertas, entregados y
//      cancelados del día, pedidos sin fecha de movimiento. Nadie los escribe:
//      se cuentan.
//
// No se mezclan. Cuando lo declarado y lo medido no coinciden, ESE es el dato
// interesante, y sale solo.
//
// ── Lo que este archivo NO hace ─────────────────────────────────────────────
// No define qué es "accionable" ni recalcula la cola. Esa definición vive en
// `segLists.ts` y ya la aplicó el cliente al firmar el cierre; reimplementarla
// en SQL crearía una SEGUNDA definición que se desincroniza — el error que
// dejó el contador clavado en 222 y el que hizo que el hero y el panel del
// turno mostraran "9 de 32" y "21 de 32" a la vez.
//
// Puro: sin red, sin Deno, sin reloj. Se prueba desde `src/lib/`.

export interface CierreDeAsesora {
  nombre: string;
  cola: number;
  gestionados: number;
  faltaron: number;
  motivo: string | null;
}

export interface DatosResumen {
  tienda: string;
  /** Día del resumen, ya formateado (ej. "viernes, 21 de agosto"). */
  dia: string;
  /** Lo que el equipo declaró al cerrar. Vacío = nadie cerró. */
  cierres: CierreDeAsesora[];
  /** Cuántas personas del equipo podrían haber cerrado. */
  asesorasDelTurno: number;
  novedadesAbiertas: number;
  /** `null` = no se pudo contar. NUNCA 0 por un error — ver el guardián. */
  entregadosHoy: number | null;
  canceladosHoy: number | null;
  /** Pedidos vivos sin fecha de último movimiento: fuera de toda alarma. */
  sinFechaDeMovimiento: number;
  /** Minutos desde la última sincronización con Dropi. `null` = no se sabe. */
  minutosDesdeSync: number | null;
}

export interface Resumen {
  asunto: string;
  /** Cuerpo en texto plano. Es lo que se manda: se lee en cualquier cliente. */
  texto: string;
  /** Lo más importante, para una notificación corta. */
  titular: string;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** `null` = no se pudo contar. Se dice, no se maquilla de cero. */
const cifra = (n: number | null) => (n === null ? 'sin dato' : String(n));

/**
 * El titular: UNA frase con lo que el dueño necesita saber si no lee nada más.
 *
 * El orden es el mismo criterio de la escalera — lo que se pierde si espera.
 * Lo que quedó sin gestionar va primero porque es lo único que todavía se puede
 * salvar; el resto ya pasó.
 */
export function titularDe(d: DatosResumen): string {
  const sinCerrar = Math.max(d.asesorasDelTurno - d.cierres.length, 0);
  const faltaron = d.cierres.reduce((n, c) => n + c.faltaron, 0);

  if (d.cierres.length === 0 && d.asesorasDelTurno > 0) {
    return 'Nadie cerró el día en Seguimiento.';
  }
  if (faltaron > 0) {
    return `Quedaron ${plural(faltaron, 'pedido sin gestionar', 'pedidos sin gestionar')}.`;
  }
  if (sinCerrar > 0) {
    return `Seguimiento en cero, pero ${plural(sinCerrar, 'persona no cerró', 'personas no cerraron')} su día.`;
  }
  if (d.novedadesAbiertas > 0) {
    return `Seguimiento cerró en cero. Quedan ${plural(d.novedadesAbiertas, 'novedad abierta', 'novedades abiertas')}.`;
  }
  return 'Seguimiento cerró en cero.';
}

export function construirResumen(d: DatosResumen): Resumen {
  const titular = titularDe(d);
  const L: string[] = [];

  L.push(`${d.tienda} — ${d.dia}`);
  L.push('');
  L.push(titular);
  L.push('');

  // ── 1. Lo que declaró el equipo ──────────────────────────────────
  L.push('CÓMO CERRÓ EL EQUIPO');
  if (d.cierres.length === 0) {
    L.push(
      d.asesorasDelTurno > 0
        ? `  Nadie firmó el cierre (${plural(d.asesorasDelTurno, 'persona en el turno', 'personas en el turno')}).`
        : '  Sin equipo asignado a esta tienda.',
    );
    // El silencio no es "todo bien": es que no se sabe. Se dice con todas las
    // letras, porque un resumen que se calla acá se lee como un día tranquilo.
    L.push('  Sin cierre no se sabe cómo terminó la cola, solo lo que se cuenta abajo.');
  } else {
    for (const c of d.cierres) {
      const linea = c.faltaron === 0
        ? `  ${c.nombre}: en cero (${c.gestionados} de ${c.cola}).`
        : `  ${c.nombre}: faltaron ${c.faltaron} de ${c.cola}.`;
      L.push(linea);
      if (c.faltaron > 0 && c.motivo) L.push(`      «${c.motivo}»`);
    }
    const sinCerrar = Math.max(d.asesorasDelTurno - d.cierres.length, 0);
    if (sinCerrar > 0) {
      L.push(`  ${plural(sinCerrar, 'persona no cerró', 'personas no cerraron')} su día.`);
    }
  }

  // ── 2. Lo que la base cuenta sola ────────────────────────────────
  L.push('');
  L.push('LO QUE MIDE GUARDIAN');
  // ⛔ `null` se imprime "sin dato", nunca 0. Esto ya falló una vez, el mismo
  // día que se escribió: la consulta filtraba por una columna que no existe
  // (`orders.updated_at`), PostgREST devolvía error, el conteo llegaba null y
  // un `?? 0` lo convertía en "Entregados hoy: 0" con toda la cara de dato
  // medido. El dueño habría leído un día sin entregas que en realidad nadie
  // contó.
  L.push(`  Entregados hoy: ${cifra(d.entregadosHoy)}`);
  L.push(`  Cancelados hoy: ${cifra(d.canceladosHoy)}`);
  L.push(`  Novedades abiertas ahora: ${d.novedadesAbiertas}`);
  if (d.sinFechaDeMovimiento > 0) {
    L.push(
      `  Sin fecha de movimiento: ${d.sinFechaDeMovimiento} ` +
      '(no aparecen en ninguna alarma — se arreglan refrescándolos desde Dropi)',
    );
  }
  L.push(
    d.minutosDesdeSync === null
      ? '  Sincronización con Dropi: sin dato'
      : `  Última sincronización con Dropi: hace ${d.minutosDesdeSync} min`,
  );

  L.push('');
  L.push('— Guardian');

  return {
    asunto: `${d.tienda} · ${titular}`,
    texto: L.join('\n'),
    titular,
  };
}
