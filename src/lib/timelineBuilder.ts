/**
 * timelineBuilder — builds a unified chronological timeline for an order
 *
 * Combines multiple data sources (touchpoints, notes, order_results, the
 * order itself) into a single sorted list of TimelineEvent objects that the
 * Timeline UI component can render directly.
 *
 * Pure TypeScript, no React / no DB. Can be tested in isolation.
 *
 * Future extensibility: the `buildTimeline` input is a sources object, so
 * adding new sources (whatsapp_messages, shopify_events, carrier_movements)
 * only requires extending the function signature, not the component that
 * renders the timeline.
 */

export type TimelineCategory =
  | 'dropi'      // sync, estado changes, guia generada
  | 'call'       // phone call logged
  | 'whatsapp'   // whatsapp message (manual or automated)
  | 'sms'        // SMS message
  | 'note'       // operator's written note
  | 'status'     // order results: conf / canc / noresp
  | 'system'     // system events (created, uploaded, etc.)
  | 'novedad';   // novedad-related actions (report / resolve)

export interface TimelineEvent {
  id: string;                // unique key for React rendering
  timestamp: Date;           // when the event happened
  category: TimelineCategory;
  title: string;             // short headline
  description?: string;      // optional longer detail
  actor?: string;            // who did it (operator display_name or "Sistema"/"Dropi")
}

// ---- Input shapes -------------------------------------------------------

export interface TimelineOrderRow {
  id: string;
  external_id?: string | null;
  nombre?: string | null;
  estado?: string | null;
  fecha?: string | null;          // "YYYY-MM-DD"
  fecha_conf?: string | null;     // "YYYY-MM-DD"
  guia?: string | null;
  transportadora?: string | null;
  novedad?: string | null;
  novedad_sol?: boolean | null;
  upload_date?: string | null;    // "YYYY-MM-DD"
  created_at?: string | null;     // ISO timestamp
}

export interface TimelineTouchpoint {
  id: string;
  phone: string;
  action: string;
  operator_id: string | null;
  action_date: string | null;     // "YYYY-MM-DD"
  action_time: string | null;     // "HH:MM" (24h)
  created_at: string;             // ISO timestamp
}

export interface TimelineNote {
  id: string;
  note_text: string;
  operator_id: string | null;
  created_at: string;             // ISO timestamp
}

export interface TimelineOrderResult {
  id: string;
  result: string;                 // 'conf' | 'canc' | 'noresp'
  reason: string | null;
  operator_id: string | null;
  result_date: string | null;     // "YYYY-MM-DD"
  result_time: string | null;     // "HH:MM"
  created_at: string;             // ISO timestamp
}

/** Un cambio de estado de Dropi registrado en order_status_history. */
export interface TimelineStatusChange {
  id: string | number;
  status: string;
  changed_at: string;             // ISO timestamp
}

export interface TimelineSources {
  order: TimelineOrderRow;
  touchpoints: TimelineTouchpoint[];
  notes: TimelineNote[];
  orderResults: TimelineOrderResult[];
  /** Historial de estados de Dropi (order_status_history) — el recorrido real. */
  statusChanges?: TimelineStatusChange[];
  /** Map operator_id → display_name so we can show "por María" instead of a UUID. */
  operatorNames?: Record<string, string>;
}

/** Etiquetas humanas para los estados de Dropi en el timeline. */
const STATUS_LABELS: Record<string, string> = {
  'PENDIENTE CONFIRMACION': 'Pendiente de confirmación',
  'PENDIENTE': 'Pendiente',
  'CONFIRMADO': 'Confirmado',
  'GUIA_GENERADA': 'Guía generada',
  'GUIA GENERADA': 'Guía generada',
  'ADMITIDA': 'Admitida por transportadora',
  'PREPARADO PARA TRANSPORTADORA': 'Preparado para transportadora',
  'ENTREGADO A TRANSPORTADORA': 'Entregado a transportadora',
  'DESPACHADA': 'Despachada',
  'DESPACHADO': 'Despachado',
  'EN TRANSPORTE': 'En transporte',
  'EN REPARTO': 'En reparto',
  'EN OFICINA': 'En oficina',
  'NOVEDAD': 'Novedad',
  'INTENTO DE ENTREGA': 'Intento de entrega',
  'ENTREGADO': 'Entregado',
  'DEVOLUCION': 'Devolución',
  'DEVOLUCION EN TRANSITO': 'Devolución en tránsito',
  'RECHAZADO': 'Rechazado',
  'CANCELADO': 'Cancelado',
};

/** Convierte un estado crudo de Dropi en una etiqueta legible. */
export function prettyStatus(raw: string): string {
  const up = (raw || '').toUpperCase().trim();
  if (STATUS_LABELS[up]) return STATUS_LABELS[up];
  // Fallback: title-case quitando guiones bajos.
  return up.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Internal helpers ---------------------------------------------------

/** Parse a "YYYY-MM-DD" + "HH:MM" combo into a Date. Falls back to the date alone, or null. */
function parseDateTime(date: string | null | undefined, time?: string | null): Date | null {
  if (!date) return null;
  const iso = time ? `${date}T${time}:00` : `${date}T00:00:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse an ISO string into a Date, or null. */
function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

interface ParsedTouchpoint {
  category: TimelineCategory;
  title: string;
  description?: string;
}

/**
 * Categorizes a touchpoint action string into a timeline event shape.
 * Recognizes both current conventions and future ones (whatsapp, call, sms).
 *
 * Current conventions:
 *   "Confirmado"                          → status/conf
 *   "Cancelado: <reason>"                 → status/canc
 *   "No respondió"                        → status/noresp
 *   "NOVEDAD: Volver a ofrecer — <sol>"   → novedad/reoffer
 *   "NOVEDAD: Devolver al remitente"      → novedad/return
 *
 * Future conventions (already handled, safe to emit from anywhere):
 *   "CALL: <detail>"                      → call
 *   "WHATSAPP: <detail>"                  → whatsapp
 *   "SMS: <detail>"                       → sms
 */
export function parseTouchpointAction(action: string): ParsedTouchpoint {
  const trimmed = (action || '').trim();

  // Current conventions
  if (trimmed === 'Confirmado') {
    return { category: 'status', title: 'Confirmado por operadora' };
  }
  if (trimmed.startsWith('Cancelado')) {
    const reason = trimmed.replace(/^Cancelado:?\s*/i, '').trim();
    return {
      category: 'status',
      title: 'Cancelado por operadora',
      description: reason || undefined,
    };
  }
  if (trimmed === 'No respondió' || trimmed === 'No respondio') {
    return { category: 'status', title: 'No respondió la llamada' };
  }
  if (trimmed.startsWith('NOVEDAD:')) {
    const rest = trimmed.replace(/^NOVEDAD:\s*/i, '').trim();
    // "Volver a ofrecer — <solution>"
    const sep = rest.indexOf('—');
    if (sep >= 0) {
      const head = rest.slice(0, sep).trim();
      const tail = rest.slice(sep + 1).trim();
      return {
        category: 'novedad',
        title: `Novedad: ${head}`,
        description: tail || undefined,
      };
    }
    return { category: 'novedad', title: `Novedad: ${rest}` };
  }

  // Future conventions (extensibility hooks)
  if (trimmed.startsWith('CALL:')) {
    return { category: 'call', title: 'Llamada', description: trimmed.slice(5).trim() || undefined };
  }
  if (trimmed.startsWith('WHATSAPP:')) {
    return { category: 'whatsapp', title: 'WhatsApp', description: trimmed.slice(9).trim() || undefined };
  }
  if (trimmed.startsWith('SMS:')) {
    return { category: 'sms', title: 'SMS', description: trimmed.slice(4).trim() || undefined };
  }

  // Unknown — pass through as a system event so we don't lose data
  return { category: 'system', title: trimmed || 'Evento' };
}

// ---- Main builder -------------------------------------------------------

/**
 * Builds a chronologically-sorted timeline (most recent first) from the
 * sources provided. Every event is guaranteed to have a valid `timestamp`.
 */
export function buildTimeline(sources: TimelineSources): TimelineEvent[] {
  const { order, touchpoints, notes, orderResults, statusChanges = [], operatorNames = {} } = sources;
  const events: TimelineEvent[] = [];
  const hasStatusHistory = statusChanges.length > 0;

  const actorFor = (operatorId: string | null | undefined): string | undefined => {
    if (!operatorId) return undefined;
    return operatorNames[operatorId] || 'Operadora';
  };

  // --- 1. Synthetic events derived from the order row itself ---

  // "Pedido creado" — best-effort timestamp from fecha or created_at
  const createdTs = parseDateTime(order.fecha) || parseIso(order.created_at);
  if (createdTs) {
    events.push({
      id: `order-created-${order.id}`,
      timestamp: createdTs,
      category: 'dropi',
      title: 'Pedido creado',
      description: order.external_id ? `ID Dropi: ${order.external_id}` : undefined,
      actor: 'Dropi',
    });
  }

  // "Sincronizado al CRM" — upload_date is when dropi-sync first pulled it in
  if (order.upload_date && order.upload_date !== (order.fecha || '').slice(0, 10)) {
    const uploadTs = parseDateTime(order.upload_date);
    if (uploadTs) {
      events.push({
        id: `order-uploaded-${order.id}`,
        timestamp: uploadTs,
        category: 'system',
        title: 'Sincronizado al CRM desde Dropi',
        actor: 'Sistema',
      });
    }
  }

  // "Guía generada" — inferido de fecha_conf cuando hay guía. Se OMITE si tenemos
  // el historial real de estados (incluye GUIA_GENERADA con su timestamp exacto),
  // para no duplicar. El número de guía se ve igual en "Envío y seguimiento".
  if (!hasStatusHistory && order.guia && order.fecha_conf) {
    const guiaTs = parseDateTime(order.fecha_conf);
    if (guiaTs) {
      events.push({
        id: `order-guia-${order.id}`,
        timestamp: guiaTs,
        category: 'dropi',
        title: `Guía generada — ${order.transportadora || 'transportadora'}`,
        description: `Guía: ${order.guia}`,
        actor: 'Dropi',
      });
    }
  }

  // --- 1b. Historial REAL de estados de Dropi (order_status_history) ---
  // El recorrido completo: PENDIENTE → GUIA_GENERADA → PREPARADO → DESPACHADA → …
  // Cada cambio que el sync detectó es un evento. Para GUIA_GENERADA enriquecemos
  // con el número de guía si lo tenemos en la orden.
  //
  // Dedup: order_status_history puede tener filas del trigger local forward-only
  // (estado ACTUAL) Y la entrada de Dropi para ESE MISMO estado → duplicado. Las
  // ordenamos cronológicamente y colapsamos estados iguales CONSECUTIVOS, quedándonos
  // con el timestamp más temprano (la transición real de Dropi, no la detección
  // tardía del trigger). Estados iguales NO consecutivos (ej. NOVEDAD que reaparece)
  // se conservan.
  const sortedChanges = statusChanges
    .map((sc) => ({ sc, ts: parseIso(sc.changed_at) }))
    .filter((x): x is { sc: TimelineStatusChange; ts: Date } => x.ts !== null)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  let prevStatusUp: string | null = null;
  sortedChanges.forEach(({ sc, ts }) => {
    const up = (sc.status || '').toUpperCase().trim();
    if (up === prevStatusUp) return; // colapsa estado igual consecutivo (trigger + Dropi)
    prevStatusUp = up;
    const isGuia = up === 'GUIA_GENERADA' || up === 'GUIA GENERADA';
    events.push({
      id: `status-${sc.id}`,
      timestamp: ts,
      category: 'dropi',
      title: prettyStatus(sc.status),
      description: isGuia && order.guia
        ? `Guía ${order.guia}${order.transportadora ? ` — ${order.transportadora}` : ''}`
        : undefined,
      actor: 'Dropi',
    });
  });

  // "Novedad reportada" — if the order has novedad text and is in novedad state
  if (order.novedad && order.estado && /NOVEDAD|INTENTO DE ENTREGA/i.test(order.estado)) {
    // Use fecha_conf as approximate timestamp (no better source)
    const novedadTs = parseDateTime(order.fecha_conf) || createdTs;
    if (novedadTs) {
      events.push({
        id: `order-novedad-${order.id}`,
        timestamp: novedadTs,
        category: 'novedad',
        title: 'Novedad reportada por transportadora',
        description: order.novedad,
        actor: order.transportadora || 'Transportadora',
      });
    }
  }

  // --- 2. Touchpoints (primary source of operator actions) ---
  touchpoints.forEach((tp) => {
    const ts = parseIso(tp.created_at) || parseDateTime(tp.action_date, tp.action_time);
    if (!ts) return;
    const parsed = parseTouchpointAction(tp.action);
    events.push({
      id: `tp-${tp.id}`,
      timestamp: ts,
      category: parsed.category,
      title: parsed.title,
      description: parsed.description,
      actor: actorFor(tp.operator_id),
    });
  });

  // --- 3. Order results (from CallView confirmations) ---
  // Only include if NOT already represented by an equivalent touchpoint (same day).
  // Touchpoints are the canonical source, but very old orders may only have order_results.
  orderResults.forEach((or) => {
    const ts = parseIso(or.created_at) || parseDateTime(or.result_date, or.result_time);
    if (!ts) return;

    // Skip if there's a near-duplicate touchpoint on the same minute (avoid double-rendering
    // confirmations that already have a touchpoint).
    const hasNearbyTouchpoint = touchpoints.some((tp) => {
      const tpTs = parseIso(tp.created_at);
      if (!tpTs) return false;
      const diff = Math.abs(tpTs.getTime() - ts.getTime());
      if (diff > 60_000) return false; // more than 1 minute apart
      if (or.result === 'conf' && tp.action === 'Confirmado') return true;
      if (or.result === 'canc' && tp.action.startsWith('Cancelado')) return true;
      if (or.result === 'noresp' && /No respond/i.test(tp.action)) return true;
      return false;
    });
    if (hasNearbyTouchpoint) return;

    let title: string;
    if (or.result === 'conf') title = 'Confirmado por operadora';
    else if (or.result === 'canc') title = 'Cancelado por operadora';
    else if (or.result === 'noresp') title = 'No respondió la llamada';
    else title = `Resultado: ${or.result}`;

    events.push({
      id: `or-${or.id}`,
      timestamp: ts,
      category: 'status',
      title,
      description: or.reason || undefined,
      actor: actorFor(or.operator_id),
    });
  });

  // --- 4. Notes ---
  notes.forEach((n) => {
    const ts = parseIso(n.created_at);
    if (!ts) return;
    events.push({
      id: `note-${n.id}`,
      timestamp: ts,
      category: 'note',
      title: 'Nota',
      description: n.note_text,
      actor: actorFor(n.operator_id),
    });
  });

  // --- 5. Sort descending (newest first) ---
  events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return events;
}
