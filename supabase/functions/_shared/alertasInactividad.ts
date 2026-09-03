/**
 * Alertas al dueño SIN estar conectado (3-sep-2026).
 *
 * Pedido: *"tener un control más grande sobre las operadoras y supervisores"*.
 * Todo lo que Guardian medía de inactividad vivía en el navegador de la asesora
 * (useInactivityGuard) o en un panel que el dueño tiene que abrir
 * (Productividad). Si el dueño no está mirando, nadie se entera de que alguien
 * lleva 40 minutos sin tocar nada, o de que a las 9:45 todavía no entró.
 *
 * Esta lógica es PURA (sin red, sin base) para poder probarla desde
 * `src/lib/alertasInactividad.test.ts`. La edge `alertas-inactividad` junta
 * los datos, la llama y manda el correo.
 *
 * Reglas:
 *  - Fuera del horario laboral de la tienda o en el almuerzo: nada.
 *  - `no_entro`: la persona no tiene NINGUNA gestión hoy, ya pasó la gracia
 *    desde el inicio del turno, y ALGUIEN MÁS de la tienda sí entró (así un
 *    domingo sin nadie no dispara diez avisos). Una vez por día.
 *  - `inactiva`: la última gestión fue hace ≥ umbral, sin pausa declarada
 *    abierta. El almuerzo no cuenta como inactividad. Se repite cada
 *    `repetirCadaMin` mientras siga sin tocar nada (lo decide el que llama vía
 *    `yaAvisado`).
 *
 * ⛔ Nada de esto afirma que la persona NO trabajó: dice que Guardian no vio
 * ninguna gestión. El correo lo dice con esas palabras.
 */

export type TipoAlerta = "inactiva" | "no_entro";

export interface MiembroTurno {
  userId: string;
  nombre: string;
}

export interface HorarioTienda {
  workStartMin: number;
  workEndMin: number;
  lunchStartMin: number;
  lunchEndMin: number;
}

export interface EntradaAlertas {
  /** Reloj, en ms epoch. */
  ahoraMs: number;
  /** Minuto LOCAL del día de la tienda (0..1439). */
  minutoLocal: number;
  horario: HorarioTienda;
  /** Miembros que trabajan la cola (operator + supervisor; el owner mira). */
  miembros: MiembroTurno[];
  /** Última gestión de HOY por persona (ms epoch). Quien no está, no entró. */
  ultimaGestionMs: Map<string, number>;
  /** Personas con una pausa declarada ABIERTA ahora mismo. */
  enPausa: Set<string>;
  /** ¿Ya se avisó esto de esta persona? (dedupe; lo resuelve quien llama). */
  yaAvisado: (userId: string, tipo: TipoAlerta) => boolean;
  /** Minutos sin gestión para avisar. Default 30. */
  umbralInactividadMin?: number;
  /** Minutos después del inicio del turno para avisar "no entró". Default 45. */
  graciaEntradaMin?: number;
}

export interface Alerta {
  userId: string;
  nombre: string;
  tipo: TipoAlerta;
  /** inactiva: minutos sin gestión · no_entro: minutos desde el inicio del turno. */
  minutos: number;
}

const enAlmuerzo = (min: number, h: HorarioTienda): boolean =>
  h.lunchEndMin > h.lunchStartMin && min >= h.lunchStartMin && min < h.lunchEndMin;

export function decidirAlertas(e: EntradaAlertas): Alerta[] {
  const umbral = e.umbralInactividadMin ?? 30;
  const gracia = e.graciaEntradaMin ?? 45;
  const h = e.horario;
  if (!(h.workEndMin > h.workStartMin)) return [];
  if (e.minutoLocal < h.workStartMin || e.minutoLocal >= h.workEndMin) return [];
  if (enAlmuerzo(e.minutoLocal, h)) return [];

  const alguienEntro = e.miembros.some((m) => e.ultimaGestionMs.has(m.userId));
  const out: Alerta[] = [];

  for (const m of e.miembros) {
    const ultima = e.ultimaGestionMs.get(m.userId);
    if (ultima == null) {
      // "No entró": solo cuando la tienda sí está trabajando y ya pasó la gracia.
      if (!alguienEntro) continue;
      const desdeInicio = e.minutoLocal - h.workStartMin;
      if (desdeInicio < gracia) continue;
      if (e.yaAvisado(m.userId, "no_entro")) continue;
      out.push({ userId: m.userId, nombre: m.nombre, tipo: "no_entro", minutos: desdeInicio });
      continue;
    }
    if (e.enPausa.has(m.userId)) continue;
    let ociosoMin = (e.ahoraMs - ultima) / 60_000;
    if (!Number.isFinite(ociosoMin) || ociosoMin < 0) continue;
    // El almuerzo no es inactividad: si la última gestión fue antes del
    // almuerzo y ya volvimos, se descuenta la ventana entera.
    const ultimaMinLocal = e.minutoLocal - ociosoMin;
    if (h.lunchEndMin > h.lunchStartMin && ultimaMinLocal < h.lunchStartMin && e.minutoLocal >= h.lunchEndMin) {
      ociosoMin -= (h.lunchEndMin - h.lunchStartMin);
    }
    if (ociosoMin < umbral) continue;
    if (e.yaAvisado(m.userId, "inactiva")) continue;
    out.push({ userId: m.userId, nombre: m.nombre, tipo: "inactiva", minutos: Math.round(ociosoMin) });
  }
  return out;
}

const hhmm = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Un correo por tienda y por corrida, con todas las alertas juntas. */
export function redactarCorreo(
  tienda: string,
  alertas: Alerta[],
  horaLocal: string,
  horario: HorarioTienda,
): { asunto: string; texto: string } {
  const inactivas = alertas.filter((a) => a.tipo === "inactiva");
  const noEntraron = alertas.filter((a) => a.tipo === "no_entro");
  const partes: string[] = [];
  if (inactivas.length) partes.push(`${inactivas.length} sin gestionar`);
  if (noEntraron.length) partes.push(`${noEntraron.length} sin entrar`);
  const asunto = `Guardian · ${tienda} · ${horaLocal}: ${partes.join(" · ")}`;

  const lineas: string[] = [];
  lineas.push(`${tienda} — ${horaLocal} (turno ${hhmm(horario.workStartMin)}–${hhmm(horario.workEndMin)})`);
  lineas.push("");
  if (inactivas.length) {
    lineas.push("SIN GESTIONAR AHORA MISMO");
    for (const a of inactivas) {
      lineas.push(`  · ${a.nombre}: Guardian no vio ninguna gestión hace ${a.minutos} min (sin pausa declarada).`);
    }
    lineas.push("");
  }
  if (noEntraron.length) {
    lineas.push("TODAVÍA NO ENTRARON");
    for (const a of noEntraron) {
      lineas.push(`  · ${a.nombre}: ${a.minutos} min después del inicio del turno, ni una gestión registrada.`);
    }
    lineas.push("");
  }
  lineas.push("Esto mide lo que Guardian registra (marcas, avisos, plantillas, novedades).");
  lineas.push("Una llamada sin marcar no cuenta: si la persona dice que trabajó, la bitácora en /actividad es la que decide.");
  lineas.push("El aviso de inactividad se repite cada 90 min mientras siga igual; el de entrada, una vez por día.");
  return { asunto, texto: lineas.join("\n") };
}
