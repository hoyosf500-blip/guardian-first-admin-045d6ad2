import { useState, useEffect, useRef } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOrderLock } from '@/hooks/useOrderLock';
import { OrderData, formatPhone, getTrackingUrl, truncate, dbToOrderData, isValidPhoneForCountry, getWhatsAppPhone } from '@/lib/orderUtils';
import { useStore } from '@/contexts/StoreContext';
import { useWaChat } from '@/contexts/WaChatContext';
import { formatCOP } from '@/lib/utils';
import { CANCEL_REASONS } from '@/lib/constants';
import { useSessionState } from '@/hooks/useSessionState';
// AI script generator removed — operadoras no lo usaban
import { supabase } from '@/integrations/supabase/client';
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';
import { CheckCircle2, XCircle, PhoneOff, Phone, MapPin, Package, DollarSign, Tag, AlertTriangle, ChevronLeft, ChevronRight, Mail, RotateCcw, Star, Lock, UserCog, MessageSquare, Loader2 } from 'lucide-react';
import FingerprintBadge from '@/components/FingerprintBadge';
import AddressValidationBadge from '@/components/AddressValidationBadge';
import OrderEditorDialog from '@/components/confirmar/OrderEditorDialog';
import AttemptHistory from '@/components/confirmar/AttemptHistory';
import OrderLabels from '@/components/confirmar/OrderLabels';
import { useOrderAttempts } from '@/hooks/useOrderAttempts';
import { useRefreshOrderRow } from '@/hooks/useRefreshOrderRow';
import { dupAlertsFor, overchargeFor, type ConfirmarOrderAlerts } from '@/lib/orderAlerts';
import NotesPanel from '@/components/order-notes/NotesPanel';
import { AddressAutocomplete } from '@/components/address/AddressAutocomplete';
import { AddressFeedbackCard } from '@/components/address/AddressFeedbackCard';
import { DespachoGateButton } from '@/components/address/DespachoGateButton';
import { heuristicValidate } from '@/lib/addressHeuristic';
import { issuesToMissingFields } from '@/lib/issuesToMissingFields';
import { buildWhatsAppMessage } from '@/lib/buildWhatsAppMessage';
import { buildAddressSuggestion } from '@/lib/buildAddressSuggestion';
import { mapAddressKind } from '@/lib/mapAddressKind';
import { useGoogleAddressLookup } from '@/hooks/useGoogleAddressLookup';
import { GOOGLE_PLACES_ENABLED } from '@/lib/featureFlags';
import { locationMatches } from '@/lib/locationGuard';
import { itemKey, indexOfKey, nextUnmanagedKey, resolveFallbackIdx } from '@/lib/callQueueNav';

// Validador-direcciones: helper local para gate de confirmación.
// Bug 2026-05-05 (cliente Cristian Mendez): el regex inline rechazaba
// "573229372886" porque length !== 10. Ahora delega a
// isValidColombianPhone que tolera el prefijo de país "57". Mantengo
// este wrapper para que los demás call sites del archivo no cambien.
// Country-aware: la tienda activa define la regla (CO: 10 díg / 3xx; EC: 9 díg / 9xx).
function validarTelefono(phone: string, countryCode?: string | null): boolean {
  return isValidPhoneForCountry(phone, countryCode);
}

// Validador-direcciones: guard fire-once-per-order-per-session para evitar
// que el efecto se dispare en loop si la fila no se actualiza por realtime
// inmediatamente. Vive a nivel de módulo — sobrevive remounts de CallView
// (cambios de pestaña), reset solo en refresh de página.
const autoValidatedOrderIds = new Set<string>();

// Validador-direcciones: ids con pickup_office override ya aplicado en sesión.
// Evita re-disparar el UPDATE en cada render si realtime tarda en refrescar.
const pickupOverrideAppliedIds = new Set<string>();

// Validador-direcciones: ids con stale-green override ya aplicado en sesión.
// Pedidos que tienen validation_decision='green' persistido en DB de un run
// viejo, pero la heurística client-side actual los marcaría yellow/red (ej. el
// fix de placa canónica de b4ccf19 capó el score a 65 cuando NO hay placa
// con guion explícito). El auto-validate effect skipea pedidos green, así que
// se quedan stale. Este override re-evalúa con la heurística local (sin red,
// sin Google) y corrige DB si difiere. Idempotente vía Set módulo-level.
const staleGreenOverrideIds = new Set<string>();

interface VipInfo {
  isVip: boolean;
  total: number;
  entregados: number;
  efectividad: number;
}

interface Props {
  items: OrderData[];
  /** Alertas por pedido (duplicado en curso + sobreprecio vs Shopify) —
   *  las computa ConfirmarTab una sola vez para toda la cola. */
  alerts?: ConfirmarOrderAlerts;
}

export default function CallView({ items, alerts }: Props) {
  const { markResult, undoLast, lastMark, allOrders, setAllOrders, buildWorkQueue } = useOrders();
  const { user, isAdmin } = useAuth();
  const { activeStore } = useStore();
  const countryCode = activeStore?.country_code;
  const { openChat, waEnabled } = useWaChat();
  const { claimOrder, releaseOrder } = useOrderLock();
  // FIX "Siguiente salta ~10": último pedido cuyo lock conseguimos NOSOTROS y
  // el último pedido visto — los usa el efecto release-on-navigate de abajo.
  const claimedByMeRef = useRef<string | null>(null);
  const prevViewedDbIdRef = useRef<string | null>(null);
  // Fix 2: última posición donde el ancla matcheó de verdad — el fallback la usa
  // para no saltar al tope cuando el pedido en pantalla desaparece por fuera.
  const lastGoodIdxRef = useRef(0);
  // BUG B fix: persist the customer's stable identifier (externalId or dbId),
  // not the array index. Indexes break when items reorder due to refresh/sync.
  const [callOrderId, setCallOrderId] = useSessionState<string | null>(
    'confirmar:callOrderId',
    null,
  );

  // Compute the real index from the persisted ID. If the customer is gone from
  // the queue (-1), fall back near the LAST GOOD position instead of the top.
  // Fix 2 (2026-07-07): saltar a items[0] teletransportaba a la operadora al
  // tope cuando el pedido en pantalla desaparecía por algo externo (el cron le
  // cambia el estado). `resolveFallbackIdx` la deja en el vecino (≈ el siguiente).
  let callIdx = indexOfKey(items, callOrderId);
  const matchedAnchor = callIdx >= 0;
  if (callIdx < 0) callIdx = resolveFallbackIdx(items, lastGoodIdxRef.current);

  // Recordar la última posición REAL (cuando el ancla matcheó) para alimentar el
  // fallback de arriba. Se actualiza post-commit para reflejar el índice servido.
  useEffect(() => {
    if (matchedAnchor) lastGoodIdxRef.current = callIdx;
  }, [matchedAnchor, callIdx]);

  // Re-anchor the persisted ID only when missing or stale. Never trigger on
  // items.length alone — that was causing the operator to lose their customer.
  // Fix 2: al re-anclar, usar la posición resuelta (vecino), NO el tope.
  useEffect(() => {
    if (!items.length) return;
    const exists = callOrderId
      ? items.some(o => (o.externalId || o.dbId) === callOrderId)
      : false;
    if (!exists) {
      const idx = resolveFallbackIdx(items, lastGoodIdxRef.current);
      const k = itemKey(items[idx]);
      if (k && k !== callOrderId) setCallOrderId(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOrderId, items]);

  // ⚠ ANTI DOBLE-CLICK (bug verificado: "un doble-click despacha un pedido que
  // nadie llamó"). `handleMark` avanza al SIGUIENTE pedido ANTES del await de
  // markResult (deliberado, ver el comentario largo de 2026-07-07: arregla el
  // desfase de la cola y el parpadeo). Como el avance ya ocurrió, el segundo
  // click cae sobre OTRO dbId y el guard `markingInFlight` de OrderContext —que
  // dedupea POR PEDIDO— lo deja pasar limpio: guía generada, flete cobrado,
  // producto en camino, sin llamada. El candado tiene que vivir acá, en la
  // pantalla, y ser POR ACCIÓN, no por pedido.
  //
  // Van los dos, ref Y estado, a propósito:
  //  - `markingRef` es el candado real. Dos clicks en el mismo tick de React
  //    leen el MISMO valor de estado (todavía false) porque no hubo re-render
  //    en el medio; el ref se escribe sincrónicamente y sí los separa.
  //  - `marking` es lo que ve la asesora (spinner + botones apagados). Sin
  //    señal visible la gente vuelve a hacer click — y con la cuenta de Ecuador
  //    throttleada, JUSTO cuando tarda es cuando se repite el click.
  const markingRef = useRef(false);
  const [marking, setMarking] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  // Sub-estado del modal de cancelación: cuando la operadora elige "Otro",
  // mostramos un campo de texto OBLIGATORIO en vez de cancelar de una.
  const [cancelOtroMode, setCancelOtroMode] = useState(false);
  const [cancelOtroText, setCancelOtroText] = useState('');
  // Edición de orden unificada (datos + transportadora + producto + valor).
  // `suggestedTotal` viene del chip de sobreprecio (total de Shopify).
  const [editorState, setEditorState] = useState<{ order: OrderData; suggestedTotal?: number } | null>(null);
  const refreshOrderRow = useRefreshOrderRow();
  // El modal de cancelación es estado por-componente y CallView NO se re-monta
  // al pasar de pedido (solo cambia `callOrderId`). Reseteamos al cambiar de
  // pedido para que el texto de "Otro" no se filtre al siguiente pedido.
  useEffect(() => {
    setShowCancelModal(false);
    setCancelOtroMode(false);
    setCancelOtroText('');
  }, [callOrderId]);
  const [vip, setVip] = useState<VipInfo | null>(null);
  // Validador-direcciones: override admin-only para destrabar el gate cuando
  // la dirección quedó en yellow/red pero el admin decidió despachar igual.
  const [addressOverride, setAddressOverride] = useState(false);
  // Validador-direcciones: set de orderIds con auto-validación EN VUELO.
  // Se usa para alimentar `loading` en AddressFeedbackCard — cuando el
  // efecto termina (con éxito, error, o timeout), removemos el id y la
  // card pasa a estado terminal ("Sin validar") en vez de quedarse pulsando.
  const [validatingOrderIds, setValidatingOrderIds] = useState<Set<string>>(() => new Set());

  // Validador-direcciones: cache en-memoria de sugerencias de Google Places
  // por orderId. La columna DB `suggested_address` está pendiente de migration
  // (HOTFIX 2026-04-30 la dejó comentada), así que para no perder la sugerencia
  // que devuelve la edge function en ESTA sesión, la guardamos acá. Es solo
  // cache de sesión — no persiste, no se sincroniza entre operadoras, y
  // priorizamos esta sobre la heurística local porque viene de la base real
  // de Google.
  const [googleSuggestions, setGoogleSuggestions] = useState<Record<string, string>>({});

  const o = items[Math.min(callIdx, items.length - 1)];

  // Fase 2a/2b: intentos previos del pedido (una sola query, compartida por el
  // historial de intentos Y el conteo de noresp que alimenta la etiqueta auto
  // "No contesta"). Hook antes del early-return para no violar reglas de hooks.
  const { attempts } = useOrderAttempts(o?.dbId);
  const norespCount = attempts.filter(a => a.result === 'noresp').length;

  // VIP check: query order history for this phone (F4)
  useEffect(() => {
    if (!o?.phone) { setVip(null); return; }
    let cancelled = false;
    supabase
      .from('orders')
      .select('estado')
      .eq('phone', o.phone)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const total = data.length;
        const entregados = data.filter(r => (r.estado || '').toUpperCase().includes('ENTREGADO')).length;
        const efectividad = total > 0 ? Math.round((entregados / total) * 100) : 0;
        setVip({
          isVip: total >= 3 && efectividad >= 80,
          total,
          entregados,
          efectividad,
        });
      });
    return () => { cancelled = true; };
  }, [o?.phone]);

  // Claim a lock on the current order; if held by someone else, skip forward.
  // BUG 3 fix: NO liberar el lock en cleanup. Cambiar de pestaña desmonta
  // CallView y soltaba el lock — otra operadora lo tomaba y al volver Mayra
  // perdía el cliente. El lock se libera al marcar el pedido (markResult)
  // o automáticamente por el cron release-stale-locks tras 15 min.
  useEffect(() => {
    if (!o?.dbId || !user || o.result) return;
    const orderId = o.dbId;
    let cancelled = false;
    // BUG 3 fix: NO confundir un error de red/RPC con "pedido lockeado".
    // Antes, claimOrder devolvía null tanto si el lock era ajeno como si el RPC
    // fallaba (500/timeout/RLS), y este efecto saltaba al siguiente en AMBOS
    // casos — con operadora única el toast "en uso por otra operadora" era
    // SIEMPRE falso y un 500 la sacaba del cliente a mitad de llamada.
    // Ahora `claimOrder` devuelve un resultado discriminado:
    //   - locked / no-elegible → saltar al siguiente (el pedido no es nuestro).
    //   - error                → QUEDARSE en el pedido, reintentar 1 vez.
    // El re-claim por churn de la cola sigue actuando de keep-alive del lock
    // (expira 15 min server-side); no lo tocamos.
    const attemptClaim = (retriesLeft: number) => {
      claimOrder(orderId).then(res => {
        if (cancelled) return;
        if (res.ok) { claimedByMeRef.current = orderId; return; } // lock nuestro, keep-alive OK
        // `'reason' in res` en vez de mirar solo `res.ok`: con strictNullChecks
        // apagado (tsconfig no estricto) el narrowing por el booleano `ok` no
        // descarta el miembro `{ ok: true }`, así que discriminamos por la
        // propiedad presente en la rama de error.
        if ('reason' in res && res.reason === 'error') {
          // Error transitorio del RPC: NO saltar. Reintentar una vez y si vuelve
          // a fallar, quedarse en el pedido (el cron limpia locks huérfanos).
          if (retriesLeft > 0) {
            toast.error('Error de conexión — reintentando…', { id: 'lock-retry' });
            setTimeout(() => { if (!cancelled) attemptClaim(retriesLeft - 1); }, 1_200);
          }
          return;
        }
        // reason === 'locked' | 'no-elegible': el pedido no es nuestro, saltar.
        const k = nextUnmanagedKey(items, callIdx);
        if (k) {
          setCallOrderId(k);
          // ID estable: si la operadora salta varios pedidos lockeados en
          // cadena (mismo cliente con varios pedidos), Sonner reusa el
          // toast existente en vez de apilar 5 avisos iguales.
          toast.info('Pedido en uso por otra operadora — saltando al siguiente', {
            id: 'lock-skip',
          });
        } else {
          toast.info('Pedidos disponibles agotados — todos están en atención', {
            id: 'lock-skip',
          });
        }
      });
    };
    attemptClaim(1);
    return () => { cancelled = true; };
  }, [o?.dbId, user, claimOrder, callIdx, items, setCallOrderId, o?.result]);

  // FIX "Siguiente salta ~10" (2026-07-07): liberar el lock del pedido ANTERIOR
  // al pasar a otro. Ver un pedido lo lockea (efecto de arriba) pero nada lo
  // soltaba al pasar de largo con Siguiente/Anterior — solo markResult o el cron
  // de 15 min. Con 3 operadoras navegando a la vez los locks se ACUMULABAN
  // (visto en vivo: 7 locks frescos de una sola operadora) y el skip del claim
  // saltaba en cascada por encima de todos → "Siguiente salta como a 10".
  // Guardas:
  //  - solo si el claim fue NUESTRO (claimedByMeRef) — release_order con admin
  //    puede soltar locks ajenos y NO queremos eso al pasar de largo;
  //  - solo al CAMBIAR de pedido estando montados — SIN cleanup de unmount
  //    (BUG 3: cambiar de pestaña no debe soltar el lock del cliente en atención);
  //  - handleMark anula claimedByMeRef tras marcar (markResult ya libera
  //    server-side; re-liberar era el PATCH redundante ya conocido).
  useEffect(() => {
    const prev = prevViewedDbIdRef.current;
    const cur = o?.dbId ?? null;
    if (prev && prev !== cur && claimedByMeRef.current === prev) {
      claimedByMeRef.current = null;
      void releaseOrder(prev);
    }
    prevViewedDbIdRef.current = cur;
  }, [o?.dbId, releaseOrder]);

  // Best-effort release on tab close so locks no quedan huérfanos hasta el cron.
  useEffect(() => {
    const handler = () => {
      if (o?.dbId) void releaseOrder(o.dbId);
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [o?.dbId, releaseOrder]);

  // Validador-direcciones: auto-validar pedidos pre-feature.
  // Pedidos sincronizados desde Dropi/Excel ANTES de que el feature shippeara
  // entran con validation_decision=null. La operadora abre uno y NO ve nada
  // (la card retornaba null). Aquí disparamos la edge function en background:
  //   - Solo si decision es null y la dirección tiene largo razonable.
  //   - Solo una vez por order id por sesión (autoValidatedOrderIds).
  //   - Mapeamos AMBAS shapes de respuesta (decision || status legacy).
  //   - Si la edge function no resuelve (timeout, error, decision=null sin
  //     status), caemos a `heuristicValidate` local — sin Google ni Haiku —
  //     para que el badge SIEMPRE termine en green/yellow/red en vez de
  //     trabarse en "Validando...".
  //   - El UPDATE persiste el resultado (best-effort); realtime refresca la
  //     card. Si el UPDATE falla, igual sacamos al order del set de loading.
  useEffect(() => {
    if (!o?.dbId) return;
    // Skip si decision terminal y completa:
    //   - green/pickup_office: no necesitan missing_fields
    //   - red/yellow con missing_fields ya poblados (caso normal post-fix)
    // Re-disparar si:
    //   - decision === null (pedido pre-feature, sin validar)
    //   - decision red/yellow PERO missing_fields vacío (pedidos validados
    //     ANTES del fix de issuesToMissingFields que tienen missing_fields=[])
    const isGreenOrPickup = o.validationDecision === 'green' || o.validationDecision === 'pickup_office';
    const isRedOrYellowMissingFields =
      (o.validationDecision === 'red' || o.validationDecision === 'yellow') &&
      (!o.missingFields || o.missingFields.length === 0);
    const shouldValidate = o.validationDecision === null || isRedOrYellowMissingFields;
    if (isGreenOrPickup || !shouldValidate) return;
    if (!o.direccion || o.direccion.trim().length < 5) return;
    if (o.result) return; // ya gestionado, no quemamos cuota
    // Backfill retry: si el id está marcado como ya-validado en sesión PERO
    // missing_fields quedó vacío con decision red/yellow, removerlo del Set
    // para permitir un retry. Esto cubre pedidos que se persistieron con
    // decision pero sin missing_fields antes del fix de issuesToMissingFields.
    if (
      o.dbId &&
      autoValidatedOrderIds.has(o.dbId) &&
      (o.validationDecision === 'red' || o.validationDecision === 'yellow') &&
      (!o.missingFields || o.missingFields.length === 0)
    ) {
      autoValidatedOrderIds.delete(o.dbId);
    }
    // Retry stale-null: si el ID está marcado como ya-validado pero la
    // decision quedó null (effect anterior se disparó pero falló silenciosamente
    // — RLS, red caída, edge function no respondió, etc.), removerlo del Set
    // para permitir un nuevo intento. Cubre el caso "Sin validar — escribir libre"
    // que el usuario reportó en pedidos como Gustavo Zambrano (Pasto).
    if (
      o.dbId &&
      autoValidatedOrderIds.has(o.dbId) &&
      o.validationDecision === null
    ) {
      autoValidatedOrderIds.delete(o.dbId);
    }
    if (autoValidatedOrderIds.has(o.dbId)) return;

    const orderId = o.dbId;
    const direccion = o.direccion;
    const ciudad = o.ciudad;
    const departamento = o.departamento;
    // Snapshot nombre/producto para el WhatsApp builder — se leen dentro
    // de async closures, no queremos depender del prop `o` fresco.
    const nombre = o.nombre || '';
    const producto = o.producto || '';
    autoValidatedOrderIds.add(orderId);

    setValidatingOrderIds((prev) => {
      if (prev.has(orderId)) return prev;
      const next = new Set(prev);
      next.add(orderId);
      return next;
    });
    const stopLoading = () => {
      setValidatingOrderIds((prev) => {
        if (!prev.has(orderId)) return prev;
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
    };

    let cancelled = false;
    let edgeReturned = false;
    let dbWritten = false;
    // Fallback heurístico tras 3s sin respuesta de la edge function.
    // No cancelamos la edge function (puede llegar tarde y persistir un
    // resultado mejor) — solo nos aseguramos de que la card se desbloquee.
    const fallbackTimerId = setTimeout(() => {
      if (cancelled || edgeReturned) return;
      void runHeuristicFallback();
    }, 3_000);
    // Hard stop a los 10s: si NADIE escribió DB todavía (edge function no
    // respondió, fallback no corrió, todo falló silenciosamente), forzar
    // la heurística como último recurso para que la card NUNCA termine en
    // "Sin validar". Solo después liberamos el loading.
    const hardStopTimerId = setTimeout(() => {
      if (cancelled) return;
      if (!dbWritten) {
        void runHeuristicFallback().finally(() => {
          cancelled = true;
          stopLoading();
        });
      } else {
        cancelled = true;
        stopLoading();
      }
    }, 10_000);

    const decisionFromHeuristic = (score: number): 'green' | 'yellow' | 'red' => {
      if (score >= 80) return 'green';
      if (score >= 50) return 'yellow';
      return 'red';
    };

    const runHeuristicFallback = async () => {
      if (cancelled) return;
      const result = heuristicValidate(direccion, countryCode);
      const decision = result.decision ?? decisionFromHeuristic(result.score);
      const address_kind = result.address_kind ?? null;
      // Para pickup_office la heurística devuelve missing_fields=[] explícito
      // — respetar y NO derivar de issues. Para el resto, traducir issues[] a
      // campos concretos (placa/barrio/complemento) para que la operadora vea
      // QUÉ falta exactamente, y generar el mensaje de WhatsApp listo.
      const missing_fields = result.missing_fields
        ?? issuesToMissingFields(result.issues ?? []);
      const suggested_customer_message = result.suggested_customer_message
        ?? buildWhatsAppMessage({
          missing_fields,
          nombre,
          producto,
        });
      try {
        await supabase
          .from('orders')
          .update({
            validation_decision: decision,
            address_kind,
            missing_fields,
            suggested_customer_message,
          })
          .eq('id', orderId);
        dbWritten = true;
      } catch {
        // best-effort — si falla, al menos liberamos el loading
      } finally {
        if (!cancelled) stopLoading();
      }
    };

    (async () => {
      // Google DESACTIVADO (featureFlags): no llamamos a dropi-validate-address
      // (que usa Google + Haiku). Validamos solo con la heurística local —
      // sin red, sin costo de Google. La heurística escribe el semáforo igual.
      if (!GOOGLE_PLACES_ENABLED) {
        edgeReturned = true;
        clearTimeout(fallbackTimerId);
        clearTimeout(hardStopTimerId);
        await runHeuristicFallback();
        return;
      }
      try {
        const { data, error } = await supabase.functions.invoke<{
          // Shape nueva (post Group C):
          decision?: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
          address_kind?: 'urban' | 'rural' | 'pickup_office' | 'unknown' | null;
          missing_fields?: string[];
          suggested_customer_message?: string;
          suggested_address?: string | null;
          // Shape legacy (coexiste):
          status?: 'valid' | 'suspicious' | 'invalid';
        }>('dropi-validate-address', {
          body: { direccion, ciudad, departamento },
        });
        edgeReturned = true;
        if (cancelled) return;
        if (error || !data) {
          await runHeuristicFallback();
          return;
        }
        // Mapear ambas shapes: decision tiene prioridad; si null, derivar de status.
        const decision: 'green' | 'yellow' | 'red' | 'pickup_office' | null =
          data.decision ?? (
            data.status === 'valid' ? 'green' :
            data.status === 'suspicious' ? 'yellow' :
            data.status === 'invalid' ? 'red' :
            null
          );
        if (!decision) {
          await runHeuristicFallback();
          return;
        }
        // Cache en-memoria de la sugerencia de Google. La columna DB está
        // pendiente de migration (hotfix 7aa41fd la comentó), así que sin
        // esto la sugerencia se perdería al re-render. Tiene mejor calidad
        // que la heurística local porque viene de la base real de Google.
        // Anti-alucinación: si la edge function nos manda una dirección de
        // otra ciudad/depto (Soacha cuando el pedido es Pitalito, etc.), la
        // descartamos antes de cachearla — exponerla pondría al cliente en
        // riesgo de despacho equivocado.
        if (data.suggested_address && locationMatches(data.suggested_address, ciudad, departamento)) {
          setGoogleSuggestions((prev) => ({ ...prev, [orderId]: data.suggested_address! }));
        } else if (data.suggested_address) {
          console.warn('[validador] Descartando suggested_address que no coincide con ciudad/depto:', {
            suggested: data.suggested_address,
            ciudad,
            departamento,
          });
        }
        // Si Haiku/edge function ya devolvió missing_fields y mensaje, los
        // preservamos. Si NO los devolvió (shape legacy / Haiku no resolvió
        // los detalles), derivamos localmente de la heurística para que la
        // operadora SIEMPRE vea qué falta + un mensaje WhatsApp listo.
        let final_missing_fields = data.missing_fields;
        let final_suggested_message = data.suggested_customer_message;
        if (final_missing_fields === undefined || final_suggested_message === undefined) {
          const heur = heuristicValidate(direccion, countryCode);
          // pickup_office y green: missing_fields legítimamente vacío.
          if (decision === 'green' || decision === 'pickup_office') {
            final_missing_fields = final_missing_fields ?? [];
            final_suggested_message = final_suggested_message ?? '';
          } else {
            final_missing_fields = final_missing_fields
              ?? heur.missing_fields
              ?? issuesToMissingFields(heur.issues ?? []);
            final_suggested_message = final_suggested_message
              ?? heur.suggested_customer_message
              ?? buildWhatsAppMessage({
                missing_fields: final_missing_fields,
                nombre,
                producto,
              });
          }
        }
        try {
          await supabase
            .from('orders')
            .update({
              validation_decision: decision,
              address_kind: data.address_kind ?? null,
              missing_fields: final_missing_fields,
              suggested_customer_message: final_suggested_message,
              suggested_address: data.suggested_address ?? null,
            })
            .eq('id', orderId);
          dbWritten = true;
        } catch {
          // best-effort
        }
      } catch {
        edgeReturned = true;
        if (!cancelled) await runHeuristicFallback();
      } finally {
        clearTimeout(fallbackTimerId);
        clearTimeout(hardStopTimerId);
        if (!cancelled) stopLoading();
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimerId);
      clearTimeout(hardStopTimerId);
      stopLoading();
    };
  }, [o?.dbId, o?.validationDecision, o?.missingFields, o?.direccion, o?.ciudad, o?.departamento, o?.nombre, o?.producto, o?.result]);

  // Validador-direcciones: pickup override client-side.
  // Si mapAddressKind detecta pickup_office pero la DB tiene otro decision
  // (ej. green stale persistido por la edge function vieja antes del fix
  // de regex pickup), corregir DB con UPDATE directo — sin llamar a la
  // edge function porque la decisión es 100% client-side basada en regex
  // de keywords y no quema cuota Google. Idempotente vía Set módulo-level.
  useEffect(() => {
    if (!o?.dbId || !o?.direccion) return;
    if (o.validationDecision === 'pickup_office') return; // ya correcto
    const detected = mapAddressKind(o.direccion);
    if (detected !== 'pickup_office') return;
    if (pickupOverrideAppliedIds.has(o.dbId)) return;
    pickupOverrideAppliedIds.add(o.dbId);
    void supabase
      .from('orders')
      .update({
        validation_decision: 'pickup_office',
        address_kind: 'pickup_office',
        missing_fields: [],
        suggested_customer_message: '',
      })
      .eq('id', o.dbId);
  }, [o?.dbId, o?.direccion, o?.validationDecision]);

  // Validador-direcciones: stale-green override client-side.
  // Caso real Brayan Uni — dirección "Cll4 13 38 Apartamento." tiene
  // validation_decision='green' en DB (run viejo) pero la heurística stricter
  // actual (post b4ccf19 — capeo a 65 sin placa canónica con guion) la
  // marcaría yellow. El auto-validate effect skipea pedidos green y nunca se
  // corrigen. Este efecto re-evalúa con `heuristicValidate` local; si la
  // heurística NO dice green, hacemos UPDATE corrigiendo a la decision
  // client-side. NO llama edge function — solo heurística local.
  useEffect(() => {
    if (!o?.dbId || !o?.direccion) return;
    if (o.validationDecision !== 'green') return; // solo green
    if (staleGreenOverrideIds.has(o.dbId)) return;

    // Si la heurística client-side da pickup_office, ya lo maneja el pickup
    // override; no pisar.
    const detectedKind = mapAddressKind(o.direccion);
    if (detectedKind === 'pickup_office') return;

    // Re-correr heurística stricter. Si dice green, OK — quedamos en green.
    // Si no, override.
    const heur = heuristicValidate(o.direccion, countryCode);
    // heuristicValidate solo setea .decision para pickup_office / rural-CO;
    // para direcciones URBANAS devuelve solo score. Derivamos la decisión del
    // score (mismos cortes que la IIFE visualDecision: 80=green/50=yellow) para
    // que una green urbana fuerte NO se reescriba en falso a yellow.
    const derived = heur.decision ?? (heur.score >= 80 ? 'green' : heur.score >= 50 ? 'yellow' : 'red');
    if (derived === 'green') return;

    staleGreenOverrideIds.add(o.dbId);
    const decision = derived;
    const missing_fields = heur.missing_fields ?? issuesToMissingFields(heur.issues ?? []);
    void supabase
      .from('orders')
      .update({
        validation_decision: decision,
        address_kind: heur.address_kind ?? null,
        missing_fields,
        // suggested_customer_message: ya no se renderiza en UI pero la columna
        // existe; lo limpiamos para no exponer texto stale.
        suggested_customer_message: '',
      })
      .eq('id', o.dbId);
  }, [o?.dbId, o?.direccion, o?.validationDecision]);

  // Validador-direcciones: pickup + stale-green override visual inmediato.
  // Mientras el effect de override hace el UPDATE + realtime refresca,
  // mostramos la decision corregida localmente para no exponer a la operadora
  // 1-2s a un valor stale que sabemos que es incorrecto.
  // NOTA: este cálculo vive ARRIBA del early-return para que el hook
  // useGoogleAddressLookup (más abajo) pueda gatear sobre `visualDecision`
  // sin violar las reglas de hooks (no condicionales antes de hooks).
  const visualDecision = (() => {
    if (!o?.direccion) return o?.validationDecision ?? null;
    const detected = mapAddressKind(o.direccion);
    if (detected === 'pickup_office') return 'pickup_office' as const;
    // Stale green: la heurística stricter actual capó a yellow/red, mostrar
    // la corrección YA en vez de esperar al realtime tras el UPDATE.
    if (o.validationDecision === 'green') {
      const heur = heuristicValidate(o.direccion, countryCode);
      if (heur.decision && heur.decision !== 'green') return heur.decision;
    }
    return o.validationDecision;
  })();

  // Validador-direcciones: Google Places lookup automático.
  // Cuando el pedido está yellow/red, llamamos a la edge function
  // google-places-proxy con la dirección que escribió el cliente y tomamos
  // la primera predicción como sugerencia REAL en el badge — prioritaria
  // sobre la heurística client-side. Cache en memoria por orderId vía
  // `cacheKey`. El hook es idempotente: 2 renders con misma key NO disparan
  // 2 fetches (cache + inflight ref).
  const lookupEnabled = (visualDecision === 'yellow' || visualDecision === 'red') && Boolean(o?.dbId);
  const { result: googleLookup, loading: lookupLoading } = useGoogleAddressLookup({
    direccion: o?.direccion ?? '',
    ciudad: o?.ciudad,
    // CRÍTICO: pasar departamento para que el hook descarte resultados que
    // no coincidan con la región del pedido (anti-alucinación de Google).
    departamento: o?.departamento,
    enabled: lookupEnabled,
    cacheKey: o?.dbId ?? 'noid',
  });

  // NOTA: igual que `visualDecision` arriba, este ref vive ARRIBA del
  // early-return. Estaba declarado abajo, junto al `undoActionFor` que lo usa —
  // más legible, pero ilegal: cuando la cola queda vacía el componente retorna
  // en la línea de abajo y ESTOS DOS HOOKS NO SE LLAMAN. React exige el mismo
  // número de hooks en cada render, así que al gestionar el último pedido de la
  // cola la pantalla reventaba con "rendered fewer hooks than expected".
  // El comentario largo que explica QUÉ hace este ref está donde se usa.
  const lastMarkRef = useRef(lastMark);
  useEffect(() => { lastMarkRef.current = lastMark; }, [lastMark]);

  if (!items.length || !o) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <CheckCircle2 size={40} className="mx-auto mb-3 text-success" />
        <p className="text-sm">¡Todos gestionados!</p>
      </div>
    );
  }

  // Mismos cortes de antigüedad de siempre (7 / 4 días): lo único que cambia
  // es que ahora el tono viste una pastilla completa (fondo + borde + texto),
  // no un puntito de 10px al lado de un número gris.
  const pDot = o.dias >= 7 ? 'bg-danger glow-danger' : o.dias >= 4 ? 'bg-warning glow-warning' : 'bg-success glow-success';
  const pChip = o.dias >= 7
    ? 'bg-danger/14 border-danger/30 text-danger'
    : o.dias >= 4
      ? 'bg-warning/14 border-warning/30 text-warning'
      : 'bg-success/14 border-success/30 text-success';

  // Vuelta atrás de una confirmación de más — el mismo accidente que produce
  // el doble-click. `undoLast` ya existía en OrderContext (borra el
  // order_result, borra el touchpoint y devuelve el pedido a PENDIENTE
  // CONFIRMACION) pero NINGUNA parte de la UI lo llamaba: se destructuraba y
  // moría ahí. Va como acción del toast de éxito, que es el único momento en
  // que la asesora sabe que acaba de marcar de más.
  //
  // ⚠️ POR QUÉ EL TOAST TIENE QUE ESTAR ATADO AL PEDIDO (bug encontrado en
  // verificación): `undoLast` opera sobre el `lastMark` GLOBAL del contexto, y
  // `setLastMark` se pisa con CADA marcado. Los toasts de sonner duran 4s y se
  // apilan, y esta cola está diseñada para avanzar al instante — marcar un 2°
  // pedido dentro de esos 4s es el caso NORMAL, sobre todo en "No contestó"
  // (un click, sin modal, sin ida a Dropi). Sin este guard: marco A → marco B →
  // toco "Deshacer" en el toast de A que sigue en pantalla → se revierte B.
  // Doble daño: se desmarca el pedido equivocado Y el que se quería deshacer
  // queda marcado. Si B era un 'conf' CON externalId (ya empujado a Dropi, con
  // guía), undoLast lo devuelve a PENDIENTE CONFIRMACION en la DB sin avisarle
  // a Dropi → desincronización silenciosa.
  //
  // El ref existe porque el onClick del toast cierra sobre el `lastMark` del
  // render en que se creó — que es el ANTERIOR, no el que markResult acaba de
  // escribir. El ref siempre tiene el valor vigente al momento del click.
  // (el ref se declara ARRIBA del early-return — ver la nota allá)

  const undoActionFor = (marked: OrderData) => ({
    action: {
      label: 'Deshacer',
      onClick: () => {
        const lm = lastMarkRef.current;
        // Identidad por dbId (estable); para pedidos de Excel sin dbId caemos a
        // identidad de objeto, que es lo que markResult guardó tal cual.
        const isSame = lm && (marked.dbId
          ? lm.order.dbId === marked.dbId
          : lm.order === marked);
        if (!isSame) {
          toast.info('Ese "Deshacer" ya venció: marcaste otro pedido después.');
          return;
        }
        void undoLast();
      },
    },
  });

  const handleMark = async (result: string, reason?: string) => {
    // Candado por ACCIÓN (ver markingRef arriba): mientras haya un marcado en
    // vuelo, ningún otro click entra — ni sobre este pedido ni sobre el
    // siguiente, que es el que el doble-click despachaba a ciegas.
    if (markingRef.current) return;
    markingRef.current = true;
    setMarking(true);
    try {
      await doMark(result, reason);
    } finally {
      markingRef.current = false;
      setMarking(false);
    }
  };

  const doMark = async (result: string, reason?: string) => {
    // Fix 1 (2026-07-07): calcular el SIGUIENTE con la cola FRESCA de ESTE render
    // y avanzar YA — ANTES del await de markResult. Antes se hacía en un
    // setTimeout(400ms) que leía `items`/`callIdx` viejos (stale-closure → aterrizaba
    // 1-3 posiciones desfasado si la cola cambió), y ese hueco de 400 ms era también
    // el que producía el parpadeo al tope (el pedido marcado salía del filtro
    // `pending` → callOrderId apuntaba a un pedido ausente → fallback). Avanzar ya
    // elimina el desfase Y el parpadeo. `o` sigue siendo el pedido marcado (closure).
    const nextKey = nextUnmanagedKey(items, callIdx);
    // Anular el ref ANTES de avanzar: el efecto release-on-navigate ve null para el
    // pedido marcado y NO re-libera (markResult ya lo libera server-side).
    if (claimedByMeRef.current === o.dbId) claimedByMeRef.current = null;
    if (nextKey) setCallOrderId(nextKey);
    setShowCancelModal(false);
    setCancelOtroMode(false);
    setCancelOtroText('');
    await markResult(o, result, reason);
    // markResult ya libera el lock vía release_order RPC.
    // REG-1 / H9: Para `result === 'conf'` con externalId, el toast lo
    // maneja `markResult` (flujo unificado de Dropi sync: loading →
    // success/error con mismo toastId). Pero si el pedido NO tiene
    // externalId (ej. cargado vía Excel manual sin Dropi), markResult
    // no muestra ningún toast — restauramos el success local.
    if (result === 'conf') {
      if (!o.externalId) {
        toast.success(`Confirmado — ${o.nombre.split(' ')[0]}`, undoActionFor(o));
      }
    } else if (result === 'canc') {
      // FASE 3: con externalId, markResult empuja la cancelación a Dropi y maneja
      // el toast (loading → ok/error con el mismo id). Sin externalId (Excel
      // manual) no hay nada que cancelar en Dropi → restauramos el success local.
      if (!o.externalId) {
        toast.success(`Cancelado — ${o.nombre.split(' ')[0]}`, undoActionFor(o));
      }
    } else {
      toast.success(`No respondió — ${o.nombre.split(' ')[0]}`, undoActionFor(o));
    }
  };

  const navCall = (dir: number) => {
    const target = Math.max(0, Math.min(items.length - 1, callIdx + dir));
    const k = itemKey(items[target]);
    if (k) setCallOrderId(k);
  };

  const copyPhone = () => {
    void copyToClipboard(o.phone, `${o.phone} copiado`);
  };

  // Contacto de 1 click. `getWhatsAppPhone` es country-aware (57 CO / 593 EC,
  // strip del 0 en EC) — mismo helper que usa el canal in-app.
  const waPhone = getWhatsAppPhone(o.phone, countryCode);
  const handleWhatsApp = () => {
    // Canal in-app (estilo Chatea Pro, anti-baneo) si la tienda lo tiene
    // configurado. Si no (ej. EC sin número), FALLBACK consciente a wa.me
    // externo — relajación del diseño anti-baneo SOLO para Confirmar, donde
    // hoy no hay segundo canal y el contacto está por el piso. Ver concerns.
    if (waEnabled) {
      void openChat({ phone: o.phone, name: o.nombre });
    } else {
      window.open(`https://wa.me/${waPhone}`, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <>
      {/* UNA sola fila: el chip a la izquierda y, agrupados a la derecha, el
          contador junto a las flechas — el contador es parte del control de
          navegación, no un dato suelto en el borde opuesto de la pantalla.
          `ml-auto` es obligatorio: el chip es condicional a `!o.result`, y sin
          él un justify-between con un solo hijo empujaría la navegación a la
          izquierda al marcar un resultado. */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 mb-2">
      {!o.result && (
        <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-br from-accent/24 to-accent/10 border border-accent/40 text-xs font-semibold text-accent shadow-glow3d">
          {/* Punto que late: señal de que ESTE es el pedido en curso, no una
              etiqueta más. Es la misma info que ya decía el chip. */}
          <span className="w-2 h-2 rounded-full bg-accent glow-accent motion-safe:animate-gb-pulse" aria-hidden="true" />
          <Phone size={12} aria-hidden="true" />
          Atendiendo: {o.nombre} · <span className="font-mono tabular-nums">{formatPhone(o.phone)}</span>
        </div>
      )}
        <div className="ml-auto flex items-center gap-2">
        <span className="font-mono tabular-nums text-xs text-muted-foreground px-2.5 py-1 rounded-lg bg-card/40 border border-border">{callIdx + 1} / {items.length}</span>
        <div className="flex gap-2">
          <button aria-label="Pedido anterior" onClick={() => navCall(-1)} disabled={callIdx <= 0} className="min-h-11 min-w-11 justify-center px-3 rounded-xl bg-card/40 border border-border text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center hover:text-foreground hover:border-border-strong transition-colors">
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button aria-label="Pedido siguiente" onClick={() => navCall(1)} disabled={callIdx >= items.length - 1} className="min-h-11 min-w-11 justify-center px-3 rounded-xl bg-card/40 border border-border text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center hover:text-foreground hover:border-border-strong transition-colors">
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
        </div>
      </div>

      {/* Cockpit en DOS COLUMNAS desde lg (patrón del handoff).
          Antes la dirección vivía dentro de la ficha y las notas quedaban
          debajo de todo: en 1366px la asesora tenía que scrollear entre el
          teléfono del cliente y el campo donde anota lo que le está dictando.
          Ahora la columna izquierda es "con quién hablo y qué decido" y el
          rail derecho es "qué escribo": dirección arriba, notas abajo, ambos
          a la vista mientras habla.
          Debajo de lg vuelve a una sola columna en el mismo orden de lectura. */}
      <div className="grid gap-4 items-start lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
      {/* SIN TiltCard ni sheen a propósito: esta es la ficha del modo llamada.
          La asesora la mira fijo mientras habla por teléfono y escribe notas —
          una card que se inclina con el mouse y un brillo que la cruza cada 7s
          distraen y marean en una jornada larga. El resto de la app sí los usa;
          acá el criterio es que no se mueva nada. */}
      <div
        className="relative overflow-hidden bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg hairline-top"
      >
        {/* Orbe aurora decorativo (Dirección 3D) */}
        <div className="pointer-events-none absolute -left-10 -top-24 w-72 h-72 rounded-full blur-[50px] bg-accent/15" aria-hidden="true" />
        {o.retryCount && !o.result && (
          <div className="relative flex items-center gap-2 mb-3 rounded-2xl bg-success/10 border border-success/30 px-3 py-2 pl-4 shadow-card3d">
            <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-success" aria-hidden="true" />
            <RotateCcw size={14} className="text-success" />
            <span className="text-[11px] font-semibold text-success">
              Luz verde ✓ — ya pasaron las 2h, volvé a llamar (intento {Number(o.retryCount) + 1}/3)
            </span>
          </div>
        )}

        {/* Fase 2b: etiquetas — auto (Datos incompletos / No contesta, derivadas) +
            manuales (Interesado / Difícil, compartidas por tienda). */}
        <OrderLabels
          orderId={o.dbId}
          phone={o.phone}
          validationDecision={o.validationDecision}
          missingFields={o.missingFields}
          norespCount={norespCount}
        />

        {/* Fase 2a: historial de intentos por asesor (quién llamó, qué resultó, cuándo).
            Solo se muestra si hay intentos previos → no ensucia pedidos frescos. */}
        <AttemptHistory attempts={attempts} />
        {vip?.isVip && !o.result && (
          <div className="relative flex items-center justify-between gap-2 mb-3 rounded-2xl bg-success/10 border border-success/25 px-3 py-2 pl-4 shadow-card3d">
            <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-success" aria-hidden="true" />
            <div className="flex items-center gap-2">
              <Star size={14} className="text-success fill-success" />
              <span className="text-[11px] font-semibold text-success">
                CLIENTE VIP — <span className="font-mono tabular-nums">{vip.entregados}/{vip.total}</span> entregados (<span className="font-mono tabular-nums">{vip.efectividad}%</span>)
              </span>
            </div>
            <button
              onClick={() => handleMark('conf')}
              disabled={marking}
              className="text-xs font-bold px-3 min-h-11 inline-flex items-center gap-1.5 justify-center rounded-xl bg-success/16 border border-success/40 text-success hover:bg-success/25 transition-colors whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed"
            >
              {marking && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              Confirmar sin llamar
            </button>
          </div>
        )}
        {/* Aviso DUPLICADO en el pedido mismo: el cliente ya tiene OTRO pedido en
            curso (real en Dropi o repetido en esta cola) — revisar antes de
            confirmar para no despachar dos veces. */}
        {!o.result && (() => {
          const dups = dupAlertsFor(alerts?.dupByPhone, o);
          if (dups.length === 0) return null;
          return (
            <div className="relative mb-3 rounded-2xl bg-destructive/10 border border-destructive/30 px-3 py-2 pl-4 space-y-1 shadow-card3d">
              <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-danger" aria-hidden="true" />
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} className="text-destructive flex-shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-bold text-destructive uppercase tracking-wide">
                  Posible duplicado — este cliente tiene {dups.length === 1 ? 'otro pedido' : `${dups.length} pedidos más`}
                </span>
              </div>
              <ul className="text-xs text-foreground/90 space-y-0.5 pl-6">
                {dups.slice(0, 3).map(d => (
                  <li key={`${d.source}-${d.externalId}`} className="flex items-center gap-1.5 flex-wrap">
                    <a
                      href={`/pedido/${d.externalId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono tabular-nums text-cyan hover:underline"
                    >#{d.externalId}</a>
                    <span className="text-[10px] px-2 py-0.5 rounded-lg bg-card/40 border border-border font-semibold">{d.estado}</span>
                    {d.fecha && <span className="text-muted-foreground">{d.fecha}</span>}
                    {d.source === 'cola' && <span className="text-[10px] text-muted-foreground">(en esta cola)</span>}
                  </li>
                ))}
              </ul>
              <p className="text-[10px] text-muted-foreground pl-6">
                Revisá antes de confirmar. Si hay dos en Dropi, cancelá el sobrante en el panel de Dropi.
              </p>
            </div>
          );
        })()}
        {/* Aviso SOBREPRECIO en el pedido mismo: Dropi va a cobrar más de lo que el
            cliente aceptó en Shopify. Se calcula contra o.valor VIVO → desaparece
            solo apenas se corrige. El botón precarga el total de Shopify. */}
        {!o.result && (() => {
          const oc = overchargeFor(alerts?.mismatchByExt, o);
          if (!oc) return null;
          return (
            <div className="relative mb-3 flex items-center justify-between gap-2 rounded-2xl bg-warning/10 border border-warning/30 px-3 py-2 pl-4 flex-wrap shadow-card3d">
              <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-warning" aria-hidden="true" />
              <div className="flex items-center gap-2 min-w-0">
                <DollarSign size={14} className="text-warning flex-shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-semibold text-warning">
                  Cobra de más: Dropi <span className="font-mono tabular-nums">{formatCOP(o.valor)}</span> vs Shopify <span className="font-mono tabular-nums">{formatCOP(oc.shopifyTotal)}</span> (+<span className="font-mono tabular-nums">{formatCOP(oc.overcharge)}</span>)
                </span>
              </div>
              {!o.guia && o.externalId && (
                <button
                  type="button"
                  onClick={() => setEditorState({ order: o, suggestedTotal: oc.shopifyTotal })}
                  className="text-xs font-bold px-3 min-h-11 inline-flex items-center justify-center rounded-xl bg-warning/16 border border-warning/40 text-warning hover:bg-warning/25 transition-colors whitespace-nowrap"
                >
                  Corregir a {formatCOP(oc.shopifyTotal)}
                </button>
              )}
            </div>
          );
        })()}
        {!o.result && <div className="mb-3"><FingerprintBadge phone={o.phone} /></div>}
        {/* BLOQUE DE IDENTIDAD — es lo que la asesora LEE EN VOZ ALTA por
            teléfono, así que acá la regla es al revés que en un dashboard: el
            dato manda sobre el adorno. El nombre sube de tamaño, el teléfono
            deja de ser un link de 12px perdido en una línea gris y pasa a ser
            una cifra grande en mono, y ciudad/producto/valor salen de la línea
            corrida para ser tres placas con chip de ícono y tono propio —
            ubicables por color sin releer.
            NINGUNO de estos datos lleva .hud-label: mayusculizaría nombres,
            ciudades y productos, que es justo lo que se dicta. El estado, que
            viene verbatim de Dropi, usa .hud-label-cased (mismo rótulo mono,
            SIN mayusculizar). */}
        <div className="relative flex items-center gap-2 mb-2.5 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${pChip}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${pDot}`} aria-hidden="true" />
            <span className="font-mono tabular-nums">D{o.dias}</span>
          </span>
          <span className="hud-label-cased px-2.5 py-1 rounded-lg bg-card/40 border border-border text-muted-foreground">{o.estado}</span>
        </div>

        <div className="relative text-[28px] leading-tight font-bold tracking-tight mb-3 text-foreground">{o.nombre}</div>

        <div className="relative mb-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-9 h-9 rounded-xl bg-cyan/14 border border-cyan/30 text-cyan flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <Phone size={17} />
            </span>
            <button onClick={copyPhone} aria-label={`Copiar teléfono ${formatPhone(o.phone)}`} title="Copiar teléfono" className="min-h-11 inline-flex items-center font-mono tabular-nums text-lg font-semibold text-cyan hover:underline">{formatPhone(o.phone)}</button>
            {/* Contacto de 1 click — antes el teléfono SOLO se copiaba. */}
            <a
              href={`tel:+${waPhone}`}
              className="ml-1 inline-flex items-center gap-1.5 text-xs font-semibold px-3 min-h-11 rounded-xl bg-gradient-to-br from-accent/25 to-accent/10 text-accent border border-accent/30 glow-accent hover:brightness-110 no-underline transition-all duration-200"
            >
              <Phone size={14} aria-hidden="true" /> Llamar
            </a>
            <button
              type="button"
              onClick={handleWhatsApp}
              title={waEnabled ? 'Abrir WhatsApp del cliente' : 'Abrir WhatsApp (canal externo)'}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 min-h-11 rounded-xl bg-gradient-to-br from-success/25 to-success/10 text-success border border-success/30 glow-success hover:brightness-110 transition-all duration-200"
            >
              <MessageSquare size={14} aria-hidden="true" /> WhatsApp
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex items-center gap-3 p-3 rounded-2xl bg-card/40 border border-border hover:border-border-strong transition-colors duration-200">
              <span className="w-9 h-9 rounded-xl bg-info/14 border border-info/30 text-info glow-info flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <MapPin size={16} />
              </span>
              <span className="text-sm font-medium text-foreground min-w-0 break-words">{o.ciudad || '—'}</span>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-2xl bg-card/40 border border-border hover:border-border-strong transition-colors duration-200">
              <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Package size={16} />
              </span>
              {/* Con variantes (zapatos: talla/color) se lista UNA LÍNEA POR PAR.
                  Antes salía el nombre repetido —"Sneakers, Sneakers"— y la
                  asesora no podía decirle al cliente qué tallas venían.
                  Sin variantes, o en pedidos que todavía no re-sincronizaron,
                  cae al texto de siempre.
                  OJO: esta es la ficha de CONFIRMAR (ConfirmarTab → CallView).
                  La de Seguimiento es CrmCallView y tiene su propia copia: si
                  tocás una, tocá la otra. */}
              {(o.productosDetalle?.length ?? 0) > 0 ? (
                <div className="min-w-0 flex-1 flex flex-col gap-1">
                  {o.productosDetalle.map((l, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-2 min-w-0">
                      <span className="text-sm font-medium text-foreground min-w-0 break-words">
                        {l.nombre}
                        {l.variante && (
                          <span className="ml-1.5 inline-flex items-center rounded-lg border border-accent/30 bg-accent/14 px-1.5 py-0.5 text-[11px] font-bold text-accent align-middle">
                            {l.variante}
                          </span>
                        )}
                        {l.cantidad > 1 && (
                          <span className="ml-1.5 font-mono text-xs text-muted-foreground tabular-nums">× {l.cantidad}</span>
                        )}
                      </span>
                      {l.precio > 0 && (
                        <span className="font-mono text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatCOP(l.precio)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-sm font-medium text-foreground min-w-0 break-words">{o.producto || '—'}</span>
              )}
            </div>
            {o.valor > 0 && (
              <div className="flex items-center gap-3 p-3 rounded-2xl bg-card/40 border border-border hover:border-border-strong transition-colors duration-200 sm:col-span-2">
                <span className="w-9 h-9 rounded-xl bg-success/14 border border-success/30 text-success glow-success flex items-center justify-center flex-shrink-0" aria-hidden="true">
                  <DollarSign size={16} />
                </span>
                <span className="font-mono tabular-nums text-xl font-bold text-success num-glow-success">{formatCOP(o.valor)}</span>
              </div>
            )}
          </div>
        </div>

        {o.novedad && (
          <div className={`relative p-2.5 pl-4 rounded-2xl mb-3 text-xs inline-flex items-start gap-1.5 w-full shadow-card3d ${o.novedadSol ? 'bg-success/10 border border-success/25' : 'bg-warning/10 border border-warning/25'}`}>
            <span className={`absolute left-0 top-2 bottom-2 w-1 rounded-full ${o.novedadSol ? 'bg-success' : 'bg-warning'}`} aria-hidden="true" />
            {o.novedadSol ? <CheckCircle2 size={12} className="text-success mt-0.5" /> : <AlertTriangle size={12} className="text-warning mt-0.5" />}
            <span>{o.novedadSol ? 'RESUELTA' : 'NOVEDAD'}: {o.novedad}</span>
          </div>
        )}

        {o.guia && (
          <div className="relative mb-3 inline-flex items-center gap-2.5 px-3 py-2 rounded-2xl bg-card/40 border border-border text-xs flex-wrap">
            <span className="w-9 h-9 rounded-xl bg-info/14 border border-info/30 text-info glow-info flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <Tag size={16} />
            </span>
            Guía: <a href={getTrackingUrl(o.transportadora, o.guia, countryCode) || '#'} target="_blank" rel="noreferrer" className="font-mono tabular-nums text-sm font-semibold text-cyan hover:underline">{o.guia}</a>
            {o.transportadora && <span className="hud-label-cased text-muted-foreground">{o.transportadora}</span>}
          </div>
        )}


        {/* Edición de orden unificada estilo Dropi: datos + dirección +
            transportadora + producto + valor en un solo diálogo. */}
        {!o.result && o.externalId && (
          <div className="mb-3 grid gap-2">
            <button
              type="button"
              onClick={() => setEditorState({ order: o })}
              title="Editar orden (datos, transportadora, cantidades y valor)"
              aria-label="Editar orden"
              className="w-full inline-flex items-center justify-center gap-1.5 py-3 rounded-xl bg-gradient-to-br from-success/22 to-success/8 border border-success/30 text-success text-sm font-semibold hover:brightness-110 hover:border-success/45 transition-all duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-success focus-visible:outline-none"
            >
              <UserCog size={15} aria-hidden="true" /> Editar orden
              {o.transportadora && <span className="opacity-70">· {o.transportadora}</span>}
              {o.valor > 0 && <span className="font-mono tabular-nums opacity-70">· {formatCOP(o.valor)}</span>}
            </button>
          </div>
        )}

      </div>
        </div>

        {/* RAIL DERECHO — lo que la asesora ESCRIBE mientras habla: la
            dirección que le está dictando y las notas del cliente. En lg+
            queda pegado (sticky) para que no se pierda al scrollear la ficha.

            max-h + overflow-y son OBLIGATORIOS junto al sticky: un elemento
            sticky más alto que el viewport se ancla arriba y su parte de abajo
            queda fuera de pantalla SIN forma de scrollearla. En 1366×768 la
            card de dirección (~450px) más las notas (~300px) pasan los ~700px
            útiles, y el campo de notas — justo lo que este layout quiere tener
            a la vista — quedaba inalcanzable. */}
        <aside className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto [scrollbar-width:thin]">
          {/* Solo se dibuja el panel si hay algo adentro: con el pedido ya
              gestionado y sin dirección, el ternario de abajo da falsy y
              quedaba una caja bordeada vacía de 360px. */}
          {(!o.result || o.direccion) && (
          <div className="bg-card/40 border border-border rounded-3xl p-5 shadow-card3d hairline-top">
        {/* Validador-direcciones v2: en modo EDIT (pedido pendiente) usamos
            AddressAutocomplete + AddressFeedbackCard. En modo VIEW (ya
            gestionado) seguimos con el badge legacy para no alterar la
            historia visual del pedido. */}
        {!o.result ? (
          <div className="mb-3 space-y-2">
            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mail size={12} /> Dirección
            </div>
            <AddressAutocomplete
              value={o.direccion}
              ciudad={o.ciudad}
              departamento={o.departamento}
              customerPhone={o.phone}
              onChange={(update) => {
                if (!o.dbId) return;
                const patch: Record<string, unknown> = { direccion: update.direccion };
                if (update.barrio !== undefined) patch.barrio = update.barrio;
                if (update.place_id !== undefined) patch.google_place_id = update.place_id;
                if (update.lat !== undefined) patch.lat = update.lat;
                if (update.lng !== undefined) patch.lng = update.lng;
                patch.address_kind = update.address_kind;
                if (update.source === 'autocomplete' || update.source === 'recurrent_customer') {
                  patch.validation_decision = 'green';
                  patch.missing_fields = [];
                  patch.suggested_customer_message = '';
                }
                void supabase.from('orders').update(patch as never).eq('id', o.dbId);
              }}
            />
            <AddressFeedbackCard
              decision={visualDecision}
              missingFields={o.missingFields ?? []}
              suggestedAddress={
                // Anti-alucinación: si la columna DB tiene una sugerencia
                // stale persistida por una edge function vieja que no coincide
                // con la ciudad/depto del pedido, NO la mostramos.
                o.suggestedAddress && locationMatches(o.suggestedAddress, o.ciudad, o.departamento)
                  ? o.suggestedAddress
                  : null
              }
              onApplySuggestion={
                o.suggestedAddress && locationMatches(o.suggestedAddress, o.ciudad, o.departamento)
                  ? () => {
                    if (!o.dbId) return;
                    void supabase.from('orders').update({
                      direccion: o.suggestedAddress,
                      validation_decision: null, // re-validar con la dirección nueva
                    }).eq('id', o.dbId);
                  }
                  : undefined
              }
              addressSuggestion={(() => {
                // Prioridad 1: Google Places real (lookup async via
                // useGoogleAddressLookup → edge function google-places-proxy).
                // Devuelve `description` con la dirección formateada por
                // Google — incluye números reales, barrio, ciudad, depto.
                if (googleLookup) {
                  return {
                    suggested: googleLookup.description,
                    missingNote: null,
                    hasEnoughInfo: true,
                  };
                }
                // Prioridad 2: cache local de la edge function dropi-validate-address
                // (si llegó a devolver suggested_address en este sesión).
                const googleSuggestion = o.dbId ? googleSuggestions[o.dbId] : undefined;
                if (googleSuggestion) {
                  return { suggested: googleSuggestion, hasEnoughInfo: true };
                }
                // Prioridad 3: heurística client-side (fallback) — arma un
                // template a partir del texto crudo, sin números reales.
                if (!o.direccion) return null;
                const heuristicSuggestion = buildAddressSuggestion({
                  direccion: o.direccion,
                  ciudad: o.ciudad,
                  departamento: o.departamento,
                  barrio: o.barrio,
                }, countryCode);
                // Sanity check: la heurística sólo usa datos del pedido y NO
                // debería poder alucinar. Aún así, si por algún bug futuro la
                // sugerencia generada pierde la ciudad/depto, la descartamos
                // para no exponer al cliente a un despacho equivocado.
                if (
                  heuristicSuggestion.hasEnoughInfo &&
                  !locationMatches(heuristicSuggestion.suggested, o.ciudad, o.departamento)
                ) {
                  return { suggested: '', missingNote: null, hasEnoughInfo: false };
                }
                return heuristicSuggestion;
              })()}
              isAdmin={isAdmin}
              carrier={o.transportadora}
              onOverrideChange={setAddressOverride}
              loading={Boolean(o.dbId && validatingOrderIds.has(o.dbId))}
              lookupLoading={lookupLoading}
            />
          </div>
        ) : (
          o.direccion && (
            <div className="text-xs text-muted-foreground mb-3 inline-flex items-center gap-1.5 flex-wrap">
              <Mail size={12} />
              <span>{o.direccion}</span>
              {/* Modo VIEW (pedido ya gestionado): mantener badge legacy. */}
              <AddressValidationBadge
                direccion={o.direccion}
                ciudad={o.ciudad}
                departamento={o.departamento}
                countryCode={countryCode}
              />
            </div>
          )
        )}
          </div>
          )}

          {/* Notas y recordatorios del cliente — visible para toda la tienda.
              Por phone (no solo orderId): si el mismo cliente tiene otro pedido,
              la asesora ve la nota previa que dejó otra compañera. */}
          {o.dbId && (
            <NotesPanel phone={o.phone} orderId={o.dbId} variant="rail" />
          )}
        </aside>

        {/* Barra de decision — fila 2 del grid, FUERA de la card.
            En movil (1 columna) el orden de lectura queda: ficha -> direccion
            -> notas -> botones. Es el orden del trabajo real: la asesora lee
            con quien habla, corrige la direccion que le dictan, anota, y
            RECIEN AHI decide. Antes esta barra vivia dentro de la card y en
            movil aparecia ANTES de la direccion: veia "Confirmo" deshabilitado
            por el gate antes de ver el campo que tenia que arreglar.
            En lg vuelve debajo de la ficha, en la columna izquierda. */}
        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
        {/* Sticky action bar en mobile: los 3 botones quedan pegados al fondo
            del viewport mientras la asesora scrollea DENTRO de la ficha.
            En sm+ vuelve a layout inline (mt-4) porque la card cabe en pantalla.

            OJO — desde que dirección y notas se movieron al rail derecho, en
            móvil (1 columna) esos dos bloques van DEBAJO de esta barra, y el
            sticky solo flota mientras su contenedor (la card) está en pantalla:
            al bajar a la dirección, los botones se van con la card. En
            escritorio no aplica (todo entra a la vez). Si se confirma que las
            asesoras trabajan desde el celular, hay que sacar esta barra de la
            card y ubicarla como fila 2 del grid, después del rail. */}
        <div className="sm:static sticky bottom-0 z-30 sm:z-auto bg-card sm:bg-transparent -mx-6 sm:mx-0 px-6 sm:px-0 pt-3 sm:pt-0 mt-4 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:pb-0 border-t sm:border-t-0 border-border">
        {!o.result ? (
          <>
          {/* ATRIBUCIÓN HONESTA DEL "EN VUELO". `doMark` avanza al SIGUIENTE
              pedido ANTES del await (fix 2026-07-07, intencional), pero
              `marking` sigue en true hasta que Dropi responde. Si el spinner
              viviera DENTRO de "Confirmó"/"No contestó", se dibujaría sobre la
              ficha del pedido NUEVO: con Ecuador throttleado (varios segundos)
              la asesora ve la tarjeta de OTRO cliente con un spinner adentro
              del botón de confirmar, sugiriendo que ESE pedido se está
              confirmando. Los botones siguen apagados (eso es lo que corta el
              doble-click), pero la señal de trabajo se dice aparte y nombra lo
              que realmente está pasando. */}
          {marking && (
            <div
              role="status"
              aria-live="polite"
              className="mb-2.5 flex items-center gap-2 rounded-xl border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground"
            >
              <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />
              <span>Guardando el marcado anterior…</span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2.5">
            {/* Validador-direcciones: el botón Confirmar pasa por el gate
                (validación dirección + teléfono + documento Coordinadora +
                override admin). Si el gate bloquea, el Button queda
                deshabilitado y el tooltip explica la razón. */}
            <DespachoGateButton
              gate={{
                // Validador-direcciones: usar visualDecision (que aplica los
                // overrides client-side de pickup_office y stale-green ANTES
                // de que el UPDATE+realtime corrija la fila en DB) — así el
                // botón coincide con lo que ve la operadora en la card.
                validation_decision: visualDecision,
                telefonoValido: validarTelefono(o.phone, countryCode),
                // includes, NO igualdad exacta: la transportadora viene verbatim
                // de Dropi (distribution_company.name) y puede ser "COORDINADORA
                // MERCANTIL", "Coordinadora S.A.", etc. Con !== 'coordinadora' el
                // gate fallaba ABIERTO (dejaba despachar sin cédula) en toda
                // variante de nombre. Coordinadora EXIGE cédula del destinatario.
                documentoSiCoordinadora:
                  !(o.transportadora || '').toLowerCase().includes('coordinadora') ||
                  Boolean(o.documentoDestinatario),
                isAdmin,
                overrideChecked: addressOverride,
              }}
              onConfirm={() => handleMark('conf')}
              // Ver markingRef: mientras el marcado viaja a Dropi el CTA se
              // apaga. Antes NO había forma de apagarlo (rama habilitada = un
              // <Button> pelado) y el segundo click despachaba el pedido
              // siguiente.
              disabled={marking}
              // Solo presentación: iguala la caja de "Canceló"/"No contestó"
              // (h-auto es imprescindible — sin él el h-10 del variant default
              // gana sobre py-4) y recupera el degradado + glow de acento del
              // handoff. Tokens por tema, nunca hex: --success ya está afinado
              // para claro (157 63% 26%) y oscuro (#34e5a0), y
              // text-success-foreground da la tinta correcta en ambos.
              // `active:scale-[0.97] transition-all` NO es adorno: sus dos
              // hermanos de fila lo tienen, y sin él el botón más importante
              // es el único que no se hunde al tocarlo en el celular. El
              // `transition-all` además reemplaza al `transition-colors` de la
              // base, que no anima `filter` y hacía saltar el brightness.
              className="w-full py-4 h-auto rounded-2xl font-bold text-sm bg-success text-success-foreground bg-gradient-to-br from-success to-success/80 border border-success/50 glow-success hover:bg-success hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-100 disabled:brightness-90"
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                <CheckCircle2 size={16} aria-hidden="true" /> Confirmó
              </span>
            </DespachoGateButton>
            <button onClick={() => setShowCancelModal(true)} disabled={marking} aria-label="Marcar como cancelado" className="inline-flex items-center justify-center gap-1.5 py-4 rounded-2xl bg-danger/12 text-danger border border-danger/34 font-bold text-sm hover:bg-danger/20 active:scale-[0.97] transition-all disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100">
              <XCircle size={16} aria-hidden="true" /> Canceló
            </button>
            <button onClick={() => handleMark('noresp')} disabled={marking} aria-label="Marcar como no contestó" className="inline-flex items-center justify-center gap-1.5 py-4 rounded-2xl bg-card/40 border border-border text-muted-foreground font-bold text-sm hover:text-foreground hover:border-border-strong active:scale-[0.97] transition-all disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100">
              <PhoneOff size={16} aria-hidden="true" /> No contestó
            </button>
          </div>
          </>
        ) : (
          /* Cierre del pedido: antes era una línea de texto suelta del mismo
             peso que cualquier nota. Ahora es una placa con el tono del
             resultado (chip + barra lateral, misma fórmula que los banners de
             la ficha) para que la asesora vea de un vistazo, sin leer, qué
             quedó marcado antes de pasar al siguiente. */
          (() => {
            // Clases literales completas, NUNCA `bg-${tone}`: Tailwind escanea
            // el texto del archivo y una clase compuesta en runtime no se
            // genera — el color simplemente no aparece.
            const skin = o.result === 'conf'
              ? { box: 'border-success/30 bg-success/10', bar: 'bg-success', chip: 'bg-success/20 text-success glow-success', text: 'text-success' }
              : o.result === 'canc'
                ? { box: 'border-danger/30 bg-danger/10', bar: 'bg-danger', chip: 'bg-danger/20 text-danger glow-danger', text: 'text-danger' }
                : { box: 'border-border bg-card/40', bar: 'bg-muted-foreground/50', chip: 'bg-muted/60 text-muted-foreground', text: 'text-muted-foreground' };
            return (
              <div className={`relative flex items-center gap-3 rounded-2xl border px-4 pl-5 py-3 shadow-card3d ${skin.box}`}>
                <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${skin.bar}`} aria-hidden="true" />
                <span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${skin.chip}`}>
                  {o.result === 'conf' ? <CheckCircle2 size={17} aria-hidden="true" /> : o.result === 'canc' ? <XCircle size={17} aria-hidden="true" /> : <PhoneOff size={17} aria-hidden="true" />}
                </span>
                <span className={`text-sm font-semibold ${skin.text}`}>
                  {o.result === 'conf' ? 'Confirmado' : o.result === 'canc' ? 'Cancelado' : 'No respondió'}
                </span>
              </div>
            );
          })()
        )}
        </div>
        </div>
      </div>

      {showCancelModal && (
        <div
          className="fixed inset-0 bg-black/70 z-[2000] flex items-end justify-center sm:items-center"
          onClick={() => { setShowCancelModal(false); setCancelOtroMode(false); setCancelOtroText(''); }}
        >
          {/* Bottom-sheet en mobile; centrado en PC (sm+), que es donde más
              trabajan las operadoras. Mismo contenido, solo cambia el anclaje. */}
          <div className="bg-card border border-border shadow-card3d-lg rounded-t-3xl sm:rounded-3xl p-6 pb-[calc(24px+env(safe-area-inset-bottom))] sm:pb-6 w-full max-w-[480px] max-h-[80vh] overflow-y-auto animate-slide-up sm:animate-none" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold mb-4 inline-flex items-center gap-2">
              <XCircle size={18} className="text-danger" /> Motivo de cancelación
            </h3>
            {!cancelOtroMode ? (
              <div className="grid gap-2">
                {CANCEL_REASONS.map(reason => {
                  // "Otro" no cancela de una: abre un campo de texto obligatorio
                  // para que la operadora escriba el motivo real.
                  const isOtro = reason.trim().toLowerCase() === 'otro';
                  return (
                    <button
                      key={reason}
                      onClick={() => (isOtro ? setCancelOtroMode(true) : handleMark('canc', reason))}
                      disabled={marking}
                      className="w-full text-left py-3 px-4 rounded-xl bg-card/40 border border-border text-muted-foreground font-semibold text-sm hover:text-foreground hover:border-border-strong transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      {reason}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="grid gap-3">
                <label htmlFor="cancel-otro-text" className="text-sm font-semibold text-muted-foreground">
                  Contanos el motivo
                </label>
                <textarea
                  id="cancel-otro-text"
                  autoFocus
                  value={cancelOtroText}
                  onChange={e => setCancelOtroText(e.target.value)}
                  placeholder="Escribí el motivo de la cancelación…"
                  rows={3}
                  maxLength={200}
                  className="w-full rounded-xl border border-border bg-card/40 p-3 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => { setCancelOtroMode(false); setCancelOtroText(''); }}
                    className="py-3 px-4 rounded-xl bg-card/40 border border-border text-muted-foreground font-semibold text-sm hover:text-foreground hover:border-border-strong transition-colors"
                  >
                    Volver
                  </button>
                  <button
                    disabled={!cancelOtroText.trim() || marking}
                    onClick={() => handleMark('canc', cancelOtroText.trim())}
                    className="py-3 px-4 rounded-xl bg-danger/12 text-danger border border-danger/34 font-bold text-sm hover:bg-danger/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
                  >
                    {marking && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                    Confirmar cancelación
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {editorState && (
        <OrderEditorDialog
          open={!!editorState}
          onOpenChange={(op) => { if (!op) setEditorState(null); }}
          order={editorState.order}
          suggestedTotal={editorState.suggestedTotal}
          onSuccess={async () => {
            // Re-fetch de la fila editada (mismo dbId aunque Dropi recree la
            // orden) + RE-ANCLAJE del pedido activo: tras un recreate el
            // external_id CAMBIA y el ancla vieja mandaba a la operadora al
            // primer pendiente (perdía su lugar en la cola).
            const updated = await refreshOrderRow(editorState.order.dbId);
            if (updated) setCallOrderId(updated.externalId || updated.dbId || null);
          }}
        />
      )}
    </>
  );
}
