import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { onGestion } from '@/lib/eventosGestion';

/**
 * Quién tocó cada uno de estos teléfonos, y hace cuánto.
 *
 * ── Por qué existe (3-sep-2026) ─────────────────────────────────────────────
 * Pedido del dueño: *"necesito etiquetas para saber que el asesor ya tocó ese
 * pedido… para yo no regañar"*. Salió de un caso real: una operadora dijo que
 * había tocado una novedad y no había con qué contrastarlo.
 *
 * Confirmar y Seguimiento ya muestran el nombre de quien gestionó. **Novedades y
 * la bandeja no muestran NADA** — ni siquiera leen las gestiones. Este hook es
 * la lectura que ahí faltaba.
 *
 * ── Dos decisiones ──────────────────────────────────────────────────────────
 *
 * 1. **Es aditivo. No toca ningún contador.** No se metió dentro de
 *    `OrderContext.loadSegCoverage` —que filtra `SEG:%` y alimenta la cobertura
 *    del día, `SegCounterBar` y el ocultamiento de tarjetas— porque ampliarle el
 *    filtro le cambiaría el valor a todos esos números de golpe. Acá se lee
 *    aparte, para pintar una etiqueta y nada más.
 *
 * 2. **Todos los módulos, no solo el de la pantalla.** Si una asesora llamó al
 *    cliente desde Confirmar, eso también cuenta como "ya lo tocaron" cuando el
 *    pedido reaparece en Novedades. Partirlo por módulo haría que el sello
 *    dijera "nadie" sobre alguien a quien sí se contactó — y ese es exactamente
 *    el regaño injusto que esto viene a evitar.
 *
 * ⛔ `estado` explícito: vacío mientras carga NO es "nadie lo tocó". Sobre esta
 * etiqueta se decide si retar a una persona; un cero afirmado antes de que
 * lleguen los datos es una acusación falsa.
 */

export type EstadoSello = 'inicial' | 'cargando' | 'ok' | 'error';

export interface Sello {
  phone: string;
  operatorId: string;
  /** `MÓDULO: acción`, tal cual se guardó. */
  action: string;
  createdAt: string;
}

/** Cuánto hacia atrás se mira. Una semana: la misma ventana con la que el
 *  tablero de Seguimiento muestra su historial, para que las pantallas no
 *  contesten distinto a la misma pregunta. */
export const VENTANA_SELLO_DIAS = 7;

/** Cuántos teléfonos por consulta. Mismo lote que usa `CrmTable`. */
const LOTE = 100;

/** `NOVEDAD: Devolución [Dropi ✓]` → `Devolución [Dropi ✓]`. */
export function accionLegible(action: string): string {
  const i = action.indexOf(':');
  return (i >= 0 ? action.slice(i + 1) : action).trim();
}

/** El módulo (`SEG`, `NOVEDAD`, `LLAMADA`…), o `''` si la fila es vieja y no lo trae. */
export function moduloDe(action: string): string {
  const i = action.indexOf(':');
  if (i >= 0) {
    const pref = action.slice(0, i).trim().toUpperCase();
    // `Cancelado: motivo` viene de Confirmar sin prefijo de módulo: el texto
    // antes de los dos puntos es el resultado, no el módulo.
    return pref === 'CANCELADO' ? 'CONFIRMAR' : pref;
  }
  // Las marcas de Confirmar (`Confirmado`, `No respondió`) tampoco llevan
  // prefijo: sin esto el sello no podía decir de qué cola vino.
  if (/^(confirmado|no respondi[oó])$/i.test(action.trim())) return 'CONFIRMAR';
  return '';
}

export function useSelloGestion(storeId: string | null, phones: string[]) {
  const { user } = useAuth();
  const [porTelefono, setPorTelefono] = useState<Record<string, Sello>>({});
  const [estado, setEstado] = useState<EstadoSello>('inicial');
  const seqRef = useRef(0);

  // La lista de teléfonos se re-arma en cada render de la pantalla. Sin esta
  // llave estable el efecto correría en cada pintada — el patrón que ya produjo
  // 112 peticiones por minuto con la pantalla quieta.
  const llave = useMemo(() => {
    const limpios = [...new Set(phones.filter(Boolean))];
    limpios.sort();
    return limpios.join(',');
  }, [phones]);

  const cargar = useCallback(async () => {
    const lista = llave ? llave.split(',') : [];
    if (!storeId || lista.length === 0) {
      setPorTelefono({});
      setEstado(storeId ? 'ok' : 'inicial');
      return;
    }
    const seq = ++seqRef.current;
    // Si ya hay un mapa bueno, se conserva mientras llega el nuevo: bajar a
    // 'cargando' con cada cliente nuevo que entra por realtime hacía que los
    // resueltos perdieran el verde y saltaran arriba ~200 ms (revisión 3-sep).
    setEstado((e) => (e === 'ok' ? e : 'cargando'));
    const desde = new Date(Date.now() - VENTANA_SELLO_DIAS * 86_400_000).toISOString();
    const lotes: string[][] = [];
    for (let i = 0; i < lista.length; i += LOTE) lotes.push(lista.slice(i, i + LOTE));

    // ⛔ PAGINADO HASTA AGOTAR (4-sep-2026). Sin `.limit()` ni `.range()`,
    // PostgREST recorta en 1.000 filas SIN error: con 100 teléfonos y 7 días de
    // toques el lote se pasaba, y los teléfonos que quedaban afuera del corte
    // salían como "nadie lo tocó" — clientes ya atendidos volvían a figurar
    // pendientes en la bandeja y el supervisor aparecía con menos deuda de la
    // real. Es el regaño injusto que el sello existe para evitar.
    const PAGINA = 1000;
    type FilaCruda = { phone: string | null; action: string | null; operator_id: string | null; created_at: string };
    const leerLote = async (lote: string[]): Promise<{ data: FilaCruda[] | null; error: unknown }> => {
      const filas: FilaCruda[] = [];
      for (let desdeFila = 0; ; desdeFila += PAGINA) {
        const r = await supabase
          .from('touchpoints')
          .select('phone, action, operator_id, created_at')
          .eq('store_id', storeId)
          .in('phone', lote)
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          // Desempate estable entre páginas.
          .order('id', { ascending: false })
          .range(desdeFila, desdeFila + PAGINA - 1);
        if (r.error) return { data: null, error: r.error };
        const pagina = (r.data ?? []) as unknown as FilaCruda[];
        filas.push(...pagina);
        if (pagina.length < PAGINA) break;
      }
      return { data: filas, error: null };
    };
    const respuestas = await Promise.all(lotes.map(leerLote));
    if (seq !== seqRef.current) return;

    // ⛔ Si UN lote falla, no se pinta un mapa a medias: la mitad de las tarjetas
    // diría "nadie lo tocó" sobre pedidos que sí fueron gestionados. Se declara
    // el error y la pantalla no muestra sellos.
    if (respuestas.some((r) => r.error)) {
      setPorTelefono({});
      setEstado('error');
      return;
    }

    const mapa: Record<string, Sello> = {};
    for (const r of respuestas) {
      type Fila = { phone: string | null; action: string | null; operator_id: string | null; created_at: string };
      for (const f of ((r.data ?? []) as unknown as Fila[])) {
        if (!f.phone || !f.operator_id) continue;
        // Vienen ordenadas de la más nueva a la más vieja: la primera de cada
        // teléfono es la última gestión, y no se pisa.
        if (mapa[f.phone]) continue;
        mapa[f.phone] = {
          phone: f.phone,
          operatorId: f.operator_id,
          action: f.action || '',
          createdAt: f.created_at,
        };
      }
    }
    setPorTelefono(mapa);
    setEstado('ok');
  }, [storeId, llave]);

  useEffect(() => { void cargar(); }, [cargar]);

  // Cuando alguien registra una gestión, el sello aparece sin esperar a que
  // nadie recargue. `touchpoints` NO está en realtime, así que la señal es el
  // evento local que emite `useRecordGestion` (ver `eventosGestion.ts`).
  const cargarRef = useRef(cargar);
  useEffect(() => { cargarRef.current = cargar; }, [cargar]);
  useEffect(() => onGestion(() => { void cargarRef.current(); }), []);

  const selloDe = useCallback(
    (phone: string | null | undefined): Sello | null => (phone ? porTelefono[phone] ?? null : null),
    [porTelefono],
  );

  return { porTelefono, selloDe, estado, miId: user?.id ?? null, recargar: cargar };
}
