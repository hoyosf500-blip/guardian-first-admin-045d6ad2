import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { repartirCola, desbalance, type AsignacionExistente } from '@/lib/repartoEquitativo';
import { presentesActivos, type FilaPresencia } from '@/lib/presenciaReparto';
import { bogotaToday } from '@/lib/utils';

/**
 * Asignación de la cola de Seguimiento del día — pieza C del protocolo del turno.
 *
 * La asignación es una **etiqueta de responsabilidad, nunca un candado**: este
 * hook no bloquea nada. Cualquier asesora sigue pudiendo gestionar cualquier
 * pedido. La etiqueta contesta dos preguntas que hoy no tienen respuesta: para
 * la asesora "¿qué es mío?", para el dueño "¿quién tenía que haber hecho esto?".
 * (Convertirla en candado fue exactamente el error de mayo-2026 que hizo apagar
 * la auto-asignación — ver `20260524120000_disable_auto_assign_operator.sql`.)
 *
 * Degrada solo: si la migración `20260821120000_seg_asignaciones.sql` no está
 * aplicada, `soportado` queda en false y la UI esconde el reparto en vez de
 * mostrar un botón que revienta. Lovable NO auto-aplica migraciones.
 */

export interface EstadoReparto {
  asignados: number;
  ignorados: number;
  sinOperadores: boolean;
  desbalance: number;
  /** Entre cuántas personas se repartió DE VERDAD (las presentes hoy). */
  entre: number;
  /** Del plantel, cuántas quedaron afuera por no haber marcado entrada hoy. */
  ausentes: number;
  /**
   * NO se repartió porque todavía no hay suficiente equipo presente. No es un
   * error: es "todavía no". El llamador NO debe sellar el día — tiene que
   * volver a intentar más tarde. Ver `HAY_QUORUM` abajo.
   */
  sinQuorum?: boolean;
}

/**
 * ⛔ CUÁNTA GENTE TIENE QUE HABER MARCADO ENTRADA PARA REPARTIR.
 *
 * ── El bug que esto evita (encontrado 28-ago-2026, ANTES de que pegara) ──────
 * El reparto va solo a quien marcó entrada hoy, y corre automático la primera
 * vez que un jefe abre Seguimiento. En Rushmira EC eso es Roberto (supervisor),
 * y a las 8 de la mañana **el único que marcó entrada es él**. Resultado:
 * `destinatarios = [Roberto]` y **los 315 pedidos del día quedaban asignados a
 * una sola persona**.
 *
 * Y no se podía deshacer solo: `repartir_seguimiento` hace
 * `ON CONFLICT DO NOTHING` y `repartirCola` nunca toca lo ya asignado, así que
 * cuando Estefano y María José llegaran a las 8:30 **no quedaba un solo pedido
 * sin dueño para repartirles**. El panel habría mostrado a Roberto con
 * "0/315 · 315 sin tocar" y a las demás "al día" con cero — leyéndose como que
 * Roberto no hace nada y el resto no tiene trabajo. Peor que no repartir.
 *
 * Con menos de dos presentes NO se reparte y NO se sella el día: se espera. La
 * cola mientras tanto es de todas (la asignación es etiqueta, nunca candado) y
 * el panel lo dice con esas palabras.
 *
 * Con una sola asesora en la tienda el quórum es 1: repartir entre una persona
 * es correcto, ahí no hay nada que equilibrar.
 */
export function quorumParaRepartir(plantel: number): number {
  return Math.min(2, Math.max(1, plantel));
}

type RespuestaSuelta = PromiseLike<{
  data: Array<Record<string, string>> | null;
  error: { code?: string; message?: string } | null;
}>;

/**
 * `seg_asignaciones` NO está en `src/integrations/supabase/types.ts`: ese
 * archivo se genera desde la base y la migración todavía no corrió (Lovable no
 * las auto-aplica). Se consulta con el tipo relajado, igual que ya se hace con
 * las RPC nuevas — y el camino degrada solo vía `faltaLaMigracion`.
 */
const sbSuelto = supabase as unknown as {
  from: (tabla: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => { eq: (col: string, val: string) => RespuestaSuelta };
    };
  };
};

/**
 * Quiénes pueden recibir trabajo AHORA: los que están TRABAJANDO, no los que
 * abrieron el CRM en algún momento del día.
 *
 * ⛔ CAMBIÓ EL 3-SEP-2026, por pedido del dueño: *"si no hay actividad no le
 * puede asignar"*. Antes bastaba con tener `first_action_at`, o sea con haber
 * marcado entrada: quien fichaba a las 8, se iba a las 9 y no volvía seguía
 * recibiendo un tercio de la cola a las 3 de la tarde — y ese tercio no lo
 * trabajaba NADIE. Ahora se exige además señal reciente (`last_active_at`).
 *
 * `null` = no se pudo leer. Es distinto de un conjunto vacío, que significa
 * "nadie está trabajando ahora"; el llamador los trata distinto.
 */
async function presenciaDeHoy(): Promise<Set<string> | null> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>)('operator_activity_stats', { p_range: 'today' });
  if (error || !Array.isArray(data)) return null;
  return presentesActivos(data as FilaPresencia[], Date.now());
}

/** Postgres: relación o función inexistente → la migración no corrió. */
function faltaLaMigracion(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST202' || err.code === '42883') return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('does not exist') || m.includes('schema cache');
}

export function useSegAsignaciones() {
  const { user } = useAuth();
  const { activeStoreId, isManagerOfActive, scopeStoreId } = useStore();
  // `operator_activity_stats` resuelve la tienda SERVER-SIDE: al cambiar de
  // tienda podía devolver la presencia de la ANTERIOR, el filtro dejaba a
  // todas afuera y el reparto se saltaba en silencio (4-sep-2026). Por ref
  // para no tocar las deps del reparto.
  const scopeOkRef = useRef(false);
  scopeOkRef.current = scopeStoreId === activeStoreId;

  /** order_id → operator_id, solo del día de hoy. */
  const [asignaciones, setAsignaciones] = useState<Map<string, string>>(new Map());
  const [operadores, setOperadores] = useState<string[]>([]);
  const [soportado, setSoportado] = useState(true);
  const [cargando, setCargando] = useState(false);
  /**
   * ⛔ `!cargando` NO es lo mismo que "ya sé".
   *
   * `cargando` arranca en `false` y solo se pone en `true` DENTRO de `cargar()`,
   * que corre en un efecto: hay un render entero en el que no está cargando y
   * tampoco leyó nada. Volviendo a `/seguimiento` desde otra pantalla la cola ya
   * está en `OrderContext`, así que el auto-reparto podía dispararse en ese
   * hueco viendo `asignaciones` vacío **porque todavía no había leído** — y
   * `repartirCola` recalcula el equilibrio desde cero, apilándole a una sola
   * persona todo lo que no tenía dueño.
   *
   * Esto se pone en `true` cuando la lectura TERMINÓ, aunque haya dado vacío.
   */
  const [cargado, setCargado] = useState(false);
  const [repartiendo, setRepartiendo] = useState(false);
  const seqRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!activeStoreId) return;
    const seq = ++seqRef.current;
    setCargando(true);

    // El día se calcula en Bogotá, igual que en la RPC. Sin esto, después de
    // las 19:00 hora local el cliente pediría el día siguiente en UTC y la
    // lista de asignaciones aparecería vacía a mitad del turno.
    //
    // ⛔ EL IDIOM ANTERIOR HACÍA EXACTAMENTE ESO (auditoría 30-ago-2026):
    //   new Date(new Date().toLocaleString('en-US', {timeZone:'America/Bogota'}))
    //     .toISOString().slice(0,10)
    // `toLocaleString` da el texto en Bogotá, pero `new Date(texto)` lo vuelve a
    // interpretar en la zona del NAVEGADOR: el desplazamiento se aplica DOS
    // veces y solo se cancela antes de las 19:00. A partir de esa hora pedía el
    // día SIGUIENTE y la lista salía vacía — justo en las dos últimas horas del
    // turno, que es cuando se cierra el día. Invisible el 80% de la jornada.
    // `bogotaToday()` formatea directo con Intl: una sola conversión.
    const hoyBogota = bogotaToday();

    const [asigRes, miembrosRes] = await Promise.all([
      sbSuelto
        .from('seg_asignaciones')
        .select('order_id, operator_id')
        .eq('store_id', activeStoreId)
        .eq('dia', hoyBogota),
      supabase
        .from('store_members')
        .select('user_id, role')
        .eq('store_id', activeStoreId),
    ]);

    if (seq !== seqRef.current) return; // una carga más nueva ganó

    if (faltaLaMigracion(asigRes.error)) {
      setSoportado(false);
      setCargando(false);
      // Se leyó y la respuesta fue "esa tabla no existe": es un resultado, no un
      // pendiente. `soportado=false` ya apaga todo el camino de reparto.
      setCargado(true);
      return;
    }

    if (!asigRes.error) {
      const m = new Map<string, string>();
      for (const r of (asigRes.data || []) as unknown as Array<{ order_id: string; operator_id: string }>) {
        if (r.order_id && r.operator_id) m.set(r.order_id, r.operator_id);
      }
      setAsignaciones(m);
    }

    if (!miembrosRes.error) {
      // Se reparte entre quienes TRABAJAN la cola: operadoras y supervisores.
      // El dueño y el admin global no entran — no atienden pedidos, y meterlos
      // les asignaría trabajo que nadie va a hacer (era medio problema del
      // sistema viejo: pedidos con dueño y sin gestión).
      const ops = ((miembrosRes.data || []) as Array<{ user_id: string; role: string }>)
        .filter((m) => m.role === 'operator' || m.role === 'supervisor')
        .map((m) => m.user_id)
        .filter(Boolean);
      // Orden estable: el reparto tiene que ser determinista corrida a corrida.
      setOperadores([...new Set(ops)].sort());
    }

    setCargando(false);
    // ⛔ Solo si la lectura de asignaciones NO dio error. Un fallo de red deja
    // `cargado` en false, y el auto-reparto —que lo exige— no corre: repartir
    // creyendo que no hay dueños cuando en realidad no se pudo leer es
    // exactamente el "cero que sustituye a no se pudo medir".
    if (!asigRes.error) setCargado(true);
  }, [activeStoreId]);

  useEffect(() => { void cargar(); }, [cargar]);

  /**
   * Reparte los pedidos que llegan (YA ORDENADOS POR URGENCIA) entre las
   * asesoras del turno. Idempotente: los que ya tienen dueño hoy no se tocan,
   * ni acá ni en la RPC (`ON CONFLICT DO NOTHING`).
   */
  const repartir = useCallback(
    async (
      orderIdsPorUrgencia: string[],
      /** `forzar` = lo apretó un jefe a mano: se reparte con quien haya. El
       *  automático NO fuerza — espera a que llegue el equipo.
       *
       *  `cargaBase` = lo que le FALTA a cada una (no lo que le tocó), para que
       *  el trabajo nuevo vaya a la que ya terminó. Ver `repartoEquitativo.ts`:
       *  es TODO O NADA, un hueco invalida el mapa entero. */
      opts?: { forzar?: boolean; cargaBase?: Map<string, number> },
    ): Promise<EstadoReparto | null> => {
      if (!activeStoreId || !isManagerOfActive || !soportado) return null;
      setRepartiendo(true);
      try {
        const yaAsignados: AsignacionExistente[] = [...asignaciones.entries()]
          .map(([orderId, operatorId]) => ({ orderId, operatorId }));

        // ⛔ Repartir entre QUIEN ESTÁ TRABAJANDO HOY, no entre el plantel.
        // `operadores` sale de `store_members`: si María José está franca igual
        // recibía un tercio de la cola, y ese tercio no lo trabajaba NADIE — es
        // medio problema del sistema viejo de auto-asignación (pedidos con dueño
        // y sin gestión).
        //
        // La presencia sale de `operator_activity_stats('today')`, que es la
        // MISMA fuente de la Jornada del panel del dueño. Va acá y no en
        // `cargar()` porque repartir corre una vez al día, no en cada render.
        // Se lee por RPC y no de `operator_activity_daily` porque esa tabla está
        // cerrada por RLS a la fila propia.
        //
        // FALLA ABIERTO, a propósito: si la lectura no responde, o nadie marcó
        // todavía (el reparto de las 8 de la mañana, con el turno recién
        // empezando), se reparte entre todas. Repartirle a alguien que no vino
        // se corrige re-repartiendo; NO repartirle a quien sí vino la deja sin
        // trabajo asignado todo el día.
        // ⛔ Y "nadie está trabajando" NO es lo mismo que "no se pudo leer"
        // (3-sep-2026). Antes las dos cosas caían en el mismo `: operadores` y
        // el reparto le daba cola al equipo entero justamente cuando nadie
        // estaba conectado. Ahora:
        //   · `null`  → no se pudo medir → se reparte entre todas (fallar abierto).
        //   · vacío   → nadie activo → NO hay destinatarios, el quórum de abajo
        //               corta y se reintenta en unos minutos.
        // Con el scope del servidor sin confirmar no se pregunta: la respuesta
        // sería de otra tienda. Se sale como "sin quórum" y el reintento de
        // cada 5 min lo agarra cuando aterrice.
        // Salvo que lo apriete un jefe a mano (`forzar`): ahí no se pregunta
        // la presencia (sería de otra tienda) y se reparte entre el plantel.
        // Sin esto, con el scope caído el botón decía "sin quórum… apretá de
        // nuevo" para siempre (revisión 3-sep-2026).
        if (!scopeOkRef.current && !opts?.forzar) {
          return {
            asignados: 0, ignorados: 0, sinOperadores: false, desbalance: 0,
            entre: 0, ausentes: operadores.length, sinQuorum: true,
          };
        }
        const presentes = scopeOkRef.current ? await presenciaDeHoy() : null;
        const filtrados = presentes === null
          ? operadores
          : operadores.filter((id) => presentes.has(id));
        // ⛔ `entre` es a QUIÉNES les tocó de verdad, y sube al llamador para que
        // el aviso no mienta. El mensaje decía «Entre N asesoras» con el plantel
        // COMPLETO aunque el reparto hubiera ido solo a las presentes: con 5 en
        // la tienda y 3 trabajando, avisaba "entre 5". Y ese aviso es lo único
        // que el jefe mira para saber si el reparto salió bien.
        // ⛔ SIN FALLBACK A `operadores`. Acá había un `filtrados.length > 0 ?
        // filtrados : operadores` que deshacía el filtro justo en el caso que
        // importa: con NADIE activo, repartía entre todo el plantel. Si no hay a
        // quién asignarle, no se asigna — el reintento de cada 5 min lo agarra
        // apenas alguien se ponga a trabajar.
        //
        // La ÚNICA excepción es el botón manual: si un jefe aprieta "repartir"
        // con nadie activo, manda él y se reparte entre el plantel. Sin esto el
        // botón contestaría «No hay asesoras en esta tienda», que es falso —
        // asesoras hay, lo que no hay es actividad— y el jefe saldría a buscar
        // un problema de configuración que no existe.
        const destinatarios = filtrados.length > 0 || !opts?.forzar ? filtrados : operadores;
        const entre = destinatarios.length;
        const ausentes = Math.max(0, operadores.length - entre);

        // ⛔ QUÓRUM: con medio equipo sin llegar, repartir es peor que esperar.
        // Ver `quorumParaRepartir` para el caso concreto que esto evita (los 315
        // pedidos del día en manos de una sola persona, sin vuelta atrás).
        // Solo aplica al automático: si un jefe aprieta el botón, manda él.
        if (!opts?.forzar && operadores.length > 0 && entre < quorumParaRepartir(operadores.length)) {
          return {
            asignados: 0, ignorados: 0, sinOperadores: false, desbalance: 0,
            entre, ausentes, sinQuorum: true,
          };
        }

        const plan = repartirCola({
          pedidos: orderIdsPorUrgencia.map((orderId) => ({ orderId })),
          operadores: destinatarios,
          yaAsignados,
          cargaBase: opts?.cargaBase,
        });

        if (plan.motivoSinAsignar === 'sin_operadores') {
          return { asignados: 0, ignorados: 0, sinOperadores: true, desbalance: 0, entre, ausentes };
        }
        if (plan.nuevas.length === 0) {
          return { asignados: 0, ignorados: 0, sinOperadores: false, desbalance: desbalance(plan.cargaFinal), entre, ausentes };
        }

        const { data, error } = await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(
          'repartir_seguimiento',
          {
            p_store_id: activeStoreId,
            p_asignaciones: plan.nuevas.map((a) => ({ order_id: a.orderId, operator_id: a.operatorId })),
            p_origen: 'auto',
          },
        );

        if (faltaLaMigracion(error)) { setSoportado(false); return null; }
        if (error) return null;

        await cargar(); // la verdad la tiene el server, no el plan local

        const fila = (Array.isArray(data) ? data[0] : data) as { asignados?: number; ignorados?: number } | null;
        return {
          asignados: fila?.asignados ?? plan.nuevas.length,
          ignorados: fila?.ignorados ?? 0,
          sinOperadores: false,
          desbalance: desbalance(plan.cargaFinal),
          entre,
          ausentes,
        };
      } finally {
        setRepartiendo(false);
      }
    },
    [activeStoreId, isManagerOfActive, soportado, asignaciones, operadores, cargar],
  );

  /** Mueve un pedido a otra asesora, o lo suelta al pool (`operatorId = null`). */
  const reasignar = useCallback(
    async (orderId: string, operatorId: string | null): Promise<boolean> => {
      if (!activeStoreId || !isManagerOfActive || !soportado) return false;
      const { error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(
        'reasignar_seguimiento',
        { p_store_id: activeStoreId, p_order_id: orderId, p_operator_id: operatorId },
      );
      if (faltaLaMigracion(error)) { setSoportado(false); return false; }
      if (error) return false;
      await cargar();
      return true;
    },
    [activeStoreId, isManagerOfActive, soportado, cargar],
  );

  /**
   * "Pedir más": la asesora que terminó se carga pedidos SIN DUEÑO, para sí
   * misma, sin que haga falta un jefe conectado.
   *
   * ── Por qué es una RPC aparte y no `repartir` ──────────────────────────────
   * `repartir_seguimiento` es manager-only, así que el reparto solo pasa
   * mientras el dueño o el supervisor tienen Seguimiento abierto. La persona que
   * vacía su lote a media mañana no tenía forma de recibir más.
   * `tomar_seguimiento` (20260903180000) es member-only y **siempre para
   * `auth.uid()`**: no hay parámetro de operador, así que por esta vía nadie
   * puede endosarle trabajo a otro.
   *
   * ⛔ Se mandan SOLO pedidos que hoy no tienen dueño. El servidor lo revalida
   * igual (`ON CONFLICT DO NOTHING`), pero filtrar acá evita gastar el tope en
   * pedidos ajenos y devolver menos de los que sí se podían tomar. Y es la
   * misma regla de siempre: no se le roba un pedido a quien ya lo tiene.
   *
   * Devuelve cuántos se tomaron de verdad (los cuenta el server, no el plan
   * local), o `null` si no se pudo.
   */
  const tomarMas = useCallback(
    async (candidatosPorUrgencia: string[], cuantos = 20): Promise<number | null> => {
      if (!activeStoreId || !user || !soportado) return null;
      const libres = candidatosPorUrgencia.filter((id) => !asignaciones.has(id));
      if (libres.length === 0) return 0;

      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(
        'tomar_seguimiento',
        { p_store_id: activeStoreId, p_order_ids: libres.slice(0, 50), p_limite: cuantos },
      );

      // ⛔ Que falte `tomar_seguimiento` NO apaga `soportado` (revisión
      // 3-sep-2026): ese flag es el del reparto entero (`repartir_seguimiento`,
      // el panel del turno, el chip "solo las mías", el botón del jefe), y esto
      // se dispara solo, al abrir la pantalla, para cualquiera con 0 sin tocar.
      // Con la migración sin aplicar, a los segundos de entrar se perdía todo
      // el módulo por una RPC que es solo el "pedir más".
      if (faltaLaMigracion(error)) {
        console.warn('[tomarMas] tomar_seguimiento no está en la base; el reparto sigue.');
        return null;
      }
      if (error) return null;

      await cargar(); // la verdad la tiene el server
      const fila = (Array.isArray(data) ? data[0] : data) as { tomados?: number } | null;
      return fila?.tomados ?? 0;
    },
    [activeStoreId, user, soportado, asignaciones, cargar],
  );

  /** ¿Este pedido es mío hoy? */
  const esMio = useCallback(
    (orderId: string | null | undefined): boolean =>
      Boolean(user && orderId && asignaciones.get(orderId) === user.id),
    [user, asignaciones],
  );

  return {
    asignaciones,
    operadores,
    soportado,
    cargando,
    cargado,
    repartiendo,
    repartir,
    reasignar,
    tomarMas,
    esMio,
    recargar: cargar,
  };
}
