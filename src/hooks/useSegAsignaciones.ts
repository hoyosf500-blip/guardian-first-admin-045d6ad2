import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { repartirCola, desbalance, type AsignacionExistente } from '@/lib/repartoEquitativo';

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
 * Quiénes dieron señal de vida HOY. `null` = no se pudo leer (y entonces el
 * reparto NO excluye a nadie — ver el comentario en `repartir`).
 *
 * Se cuenta como presente quien tenga `first_action_at`: es la marca que deja el
 * heartbeat al minuto de abrir el CRM, así que alguien que acaba de llegar y
 * todavía no gestionó nada ya entra al reparto.
 */
async function presenciaDeHoy(): Promise<Set<string> | null> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>)('operator_activity_stats', { p_range: 'today' });
  if (error || !Array.isArray(data)) return null;
  const s = new Set<string>();
  for (const r of data as Array<{ operator_id?: string; first_action_at?: string | null }>) {
    if (r.operator_id && r.first_action_at) s.add(String(r.operator_id));
  }
  return s;
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
  const { activeStoreId, isManagerOfActive } = useStore();

  /** order_id → operator_id, solo del día de hoy. */
  const [asignaciones, setAsignaciones] = useState<Map<string, string>>(new Map());
  const [operadores, setOperadores] = useState<string[]>([]);
  const [soportado, setSoportado] = useState(true);
  const [cargando, setCargando] = useState(false);
  const [repartiendo, setRepartiendo] = useState(false);
  const seqRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!activeStoreId) return;
    const seq = ++seqRef.current;
    setCargando(true);

    // El día se calcula en Bogotá, igual que en la RPC. Sin esto, después de
    // las 19:00 hora local el cliente pediría el día siguiente en UTC y la
    // lista de asignaciones aparecería vacía a mitad del turno.
    const hoyBogota = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }),
    ).toISOString().slice(0, 10);

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
  }, [activeStoreId]);

  useEffect(() => { void cargar(); }, [cargar]);

  /**
   * Reparte los pedidos que llegan (YA ORDENADOS POR URGENCIA) entre las
   * asesoras del turno. Idempotente: los que ya tienen dueño hoy no se tocan,
   * ni acá ni en la RPC (`ON CONFLICT DO NOTHING`).
   */
  const repartir = useCallback(
    async (orderIdsPorUrgencia: string[]): Promise<EstadoReparto | null> => {
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
        const presentes = await presenciaDeHoy();
        const destinatarios = presentes && presentes.size > 0
          ? operadores.filter((id) => presentes.has(id))
          : operadores;

        const plan = repartirCola({
          pedidos: orderIdsPorUrgencia.map((orderId) => ({ orderId })),
          operadores: destinatarios.length > 0 ? destinatarios : operadores,
          yaAsignados,
        });

        if (plan.motivoSinAsignar === 'sin_operadores') {
          return { asignados: 0, ignorados: 0, sinOperadores: true, desbalance: 0 };
        }
        if (plan.nuevas.length === 0) {
          return { asignados: 0, ignorados: 0, sinOperadores: false, desbalance: desbalance(plan.cargaFinal) };
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
    repartiendo,
    repartir,
    reasignar,
    esMio,
    recargar: cargar,
  };
}
