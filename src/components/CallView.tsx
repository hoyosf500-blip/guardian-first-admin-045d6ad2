import { useState, useEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOrderLock } from '@/hooks/useOrderLock';
import { OrderData, formatPhone, getTrackingUrl, truncate, dbToOrderData, isValidPhoneForCountry } from '@/lib/orderUtils';
import { useStore } from '@/contexts/StoreContext';
import { formatCOP } from '@/lib/utils';
import { CANCEL_REASONS } from '@/lib/constants';
import { useSessionState } from '@/hooks/useSessionState';
// AI script generator removed — operadoras no lo usaban
import { supabase } from '@/integrations/supabase/client';
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';
import { CheckCircle2, XCircle, PhoneOff, Phone, MapPin, Package, DollarSign, Tag, AlertTriangle, ChevronLeft, ChevronRight, Mail, RotateCcw, Star, Lock, UserCog } from 'lucide-react';
import FingerprintBadge from '@/components/FingerprintBadge';
import AddressValidationBadge from '@/components/AddressValidationBadge';
import EditOrderDialog from '@/components/EditOrderDialog';
import ChangeCarrierDialog from '@/components/confirmar/ChangeCarrierDialog';
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
}

export default function CallView({ items }: Props) {
  const { markResult, undoLast, allOrders, setAllOrders, buildWorkQueue } = useOrders();
  const { user, isAdmin } = useAuth();
  const { activeStore } = useStore();
  const countryCode = activeStore?.country_code;
  const { claimOrder, releaseOrder } = useOrderLock();
  // BUG B fix: persist the customer's stable identifier (externalId or dbId),
  // not the array index. Indexes break when items reorder due to refresh/sync.
  const [callOrderId, setCallOrderId] = useSessionState<string | null>(
    'confirmar:callOrderId',
    null,
  );

  const orderKey = (o: OrderData | undefined) =>
    o ? (o.externalId || o.dbId || null) : null;

  // Compute the real index from the persisted ID. If the customer is gone from
  // the queue (-1), fall back to the first pending order.
  let callIdx = callOrderId
    ? items.findIndex(o => (o.externalId || o.dbId) === callOrderId)
    : -1;
  if (callIdx < 0) {
    const firstPending = items.findIndex(o => !o.result);
    callIdx = firstPending >= 0 ? firstPending : 0;
  }

  // Re-anchor the persisted ID only when missing or stale. Never trigger on
  // items.length alone — that was causing the operator to lose their customer.
  useEffect(() => {
    if (!items.length) return;
    const exists = callOrderId
      ? items.some(o => (o.externalId || o.dbId) === callOrderId)
      : false;
    if (!exists) {
      const firstPending = items.find(o => !o.result) || items[0];
      const k = orderKey(firstPending);
      if (k && k !== callOrderId) setCallOrderId(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOrderId, items]);

  const [showCancelModal, setShowCancelModal] = useState(false);
  // Sub-estado del modal de cancelación: cuando la operadora elige "Otro",
  // mostramos un campo de texto OBLIGATORIO en vez de cancelar de una.
  const [cancelOtroMode, setCancelOtroMode] = useState(false);
  const [cancelOtroText, setCancelOtroText] = useState('');
  const [editingOrder, setEditingOrder] = useState<OrderData | null>(null);
  // El modal de cancelación es estado por-componente y CallView NO se re-monta
  // al pasar de pedido (solo cambia `callOrderId`). Reseteamos al cambiar de
  // pedido para que el texto de "Otro" no se filtre al siguiente pedido.
  useEffect(() => {
    setShowCancelModal(false);
    setCancelOtroMode(false);
    setCancelOtroText('');
  }, [callOrderId]);
  const [carrierOrder, setCarrierOrder] = useState<OrderData | null>(null);
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
    claimOrder(orderId).then(claimed => {
      if (cancelled) return;
      if (!claimed) {
        const next = items.find((it, i) => i > callIdx && !it.result);
        const k = orderKey(next);
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
      }
    });
    return () => { cancelled = true; };
  }, [o?.dbId, user, claimOrder, callIdx, items, setCallOrderId, o?.result]);

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
              // HOTFIX 2026-04-30: 'suggested_address' temporalmente comentado.
              // La columna aún no existe en DB de producción (migration
              // 20260502000000 pendiente). Re-habilitar cuando se aplique.
              // suggested_address: data.suggested_address ?? null,
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
    if (heur.decision === 'green') return;

    staleGreenOverrideIds.add(o.dbId);
    const decision = heur.decision ?? 'yellow';
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

  if (!items.length || !o) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <CheckCircle2 size={40} className="mx-auto mb-3 text-green" />
        <p className="text-sm">¡Todos gestionados!</p>
      </div>
    );
  }

  const pColor = o.dias >= 7 ? 'text-red' : o.dias >= 4 ? 'text-yellow' : 'text-green';
  const pDot = o.dias >= 7 ? 'bg-red' : o.dias >= 4 ? 'bg-yellow' : 'bg-green';

  const handleMark = async (result: string, reason?: string) => {
    await markResult(o, result, reason);
    // markResult ya libera el lock vía release_order RPC.
    // Llamarlo dos veces causaba un PATCH redundante a /orders.
    setShowCancelModal(false);
    setCancelOtroMode(false);
    setCancelOtroText('');
    // REG-1 / H9: Para `result === 'conf'` con externalId, el toast lo
    // maneja `markResult` (flujo unificado de Dropi sync: loading →
    // success/error con mismo toastId). Pero si el pedido NO tiene
    // externalId (ej. cargado vía Excel manual sin Dropi), markResult
    // no muestra ningún toast — restauramos el success local.
    if (result === 'conf') {
      if (!o.externalId) {
        toast.success(`Confirmado — ${o.nombre.split(' ')[0]}`);
      }
    } else {
      toast.success(
        result === 'canc' ? `Cancelado — ${o.nombre.split(' ')[0]}` :
        `No respondió — ${o.nombre.split(' ')[0]}`,
      );
    }
    setTimeout(() => {
      const next = items.find((item, i) => i > callIdx && !item.result);
      const k = orderKey(next);
      if (k) setCallOrderId(k);
    }, 400);
  };

  const navCall = (dir: number) => {
    const target = Math.max(0, Math.min(items.length - 1, callIdx + dir));
    const k = orderKey(items[target]);
    if (k) setCallOrderId(k);
  };

  const copyPhone = () => {
    void copyToClipboard(o.phone, `${o.phone} copiado`);
  };

  return (
    <>
      {!o.result && (
        <div className="mb-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary">
          <Phone size={12} />
          Atendiendo: {o.nombre} · {formatPhone(o.phone)}
        </div>
      )}
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-muted-foreground">{callIdx + 1} / {items.length}</span>
        <div className="flex gap-1.5">
          <button onClick={() => navCall(-1)} disabled={callIdx <= 0} className="px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center">
            <ChevronLeft size={14} />
          </button>
          <button onClick={() => navCall(1)} disabled={callIdx >= items.length - 1} className="px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="bg-gradient-to-b from-card to-surface border border-input rounded-2xl p-5 mb-4">
        {o.retryCount && !o.result && (
          <div className="flex items-center gap-2 mb-3 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-2">
            <RotateCcw size={14} className="text-orange-500" />
            <span className="text-[11px] font-semibold text-orange-500">
              Reintento {o.retryCount}/3 — No contestó antes, volver a llamar
            </span>
          </div>
        )}
        {vip?.isVip && !o.result && (
          <div className="flex items-center justify-between gap-2 mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
            <div className="flex items-center gap-2">
              <Star size={14} className="text-emerald-500 fill-emerald-500" />
              <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                CLIENTE VIP — {vip.entregados}/{vip.total} entregados ({vip.efectividad}%)
              </span>
            </div>
            <button
              onClick={() => handleMark('conf')}
              className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors whitespace-nowrap"
            >
              Confirmar sin llamar
            </button>
          </div>
        )}
        {!o.result && <div className="mb-3"><FingerprintBadge phone={o.phone} /></div>}
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <div className={`w-2 h-2 rounded-full ${pDot}`} />
          <span className={`text-xs font-bold ${pColor}`}>D{o.dias}</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted font-semibold">{o.estado}</span>
        </div>

        <div className="text-xl font-bold mb-1">{o.nombre}</div>

        <div className="text-sm text-muted-foreground mb-4 leading-relaxed space-y-1">
          <div className="flex items-center gap-1.5">
            <Phone size={12} /> <button onClick={copyPhone} className="text-cyan hover:underline">{formatPhone(o.phone)}</button>
            <span className="mx-2" />
            <MapPin size={12} /> {o.ciudad || '—'}
          </div>
          <div className="flex items-center gap-1.5">
            <Package size={12} /> {o.producto || '—'}
            {o.valor > 0 && <><span className="mx-2" /><DollarSign size={12} /> {formatCOP(o.valor)}</>}
          </div>
        </div>

        {o.novedad && (
          <div className={`p-2.5 rounded-lg mb-3 text-xs inline-flex items-start gap-1.5 w-full ${o.novedadSol ? 'bg-green/10 border border-green/20' : 'bg-orange/10 border border-orange/20'}`}>
            {o.novedadSol ? <CheckCircle2 size={12} className="text-green mt-0.5" /> : <AlertTriangle size={12} className="text-orange mt-0.5" />}
            <span>{o.novedadSol ? 'RESUELTA' : 'NOVEDAD'}: {o.novedad}</span>
          </div>
        )}

        {o.guia && (
          <div className="text-xs mb-2 inline-flex items-center gap-1.5">
            <Tag size={12} /> Guía: <a href={getTrackingUrl(o.transportadora, o.guia) || '#'} target="_blank" rel="noreferrer" className="text-cyan">{o.guia}</a>
            {o.transportadora && ` (${o.transportadora})`}
          </div>
        )}

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

        {/* Edit order button (AI script generator removed — unused) */}
        {!o.result && o.externalId && (
          <div className="mb-3 grid gap-2">
            <button
              type="button"
              onClick={() => setEditingOrder(o)}
              title="Editar datos del cliente"
              aria-label="Editar datos del cliente"
              className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 text-xs font-semibold hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
            >
              <UserCog size={14} aria-hidden="true" /> Editar datos del cliente
            </button>
            {/* Cambiar transportadora: solo sin guía generada (luego queda fija). */}
            {!o.guia && (
              <button
                type="button"
                onClick={() => setCarrierOrder(o)}
                title="Cambiar transportadora"
                aria-label="Cambiar transportadora"
                className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-500 text-xs font-semibold hover:bg-cyan-500/20 hover:border-cyan-500/40 transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:outline-none"
              >
                <Package size={14} aria-hidden="true" /> Cambiar transportadora
                {o.transportadora && <span className="opacity-70">· {o.transportadora}</span>}
              </button>
            )}
          </div>
        )}

        {/* Sticky action bar en mobile: los 3 botones (Confirmó/Canceló/No
            contestó) quedan pegados al fondo del viewport mientras la asesora
            scrollea por la dirección/notas/sugerencias. Si el card scroll fuera
            del viewport, sticky se va con él (esperado).
            En sm+ vuelve a layout inline (mt-4) porque la card cabe en pantalla. */}
        <div className="sm:static sticky bottom-0 z-30 sm:z-auto bg-card/95 backdrop-blur sm:bg-transparent sm:backdrop-blur-none -mx-5 sm:mx-0 px-5 sm:px-0 pt-3 sm:pt-0 mt-4 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:pb-0 border-t sm:border-t-0 border-border">
        {!o.result ? (
          <div className="grid grid-cols-3 gap-2">
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
                documentoSiCoordinadora:
                  (o.transportadora || '').toLowerCase() !== 'coordinadora' ||
                  Boolean(o.documentoDestinatario),
                isAdmin,
                overrideChecked: addressOverride,
              }}
              onConfirm={() => handleMark('conf')}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                <CheckCircle2 size={16} aria-hidden="true" /> Confirmó
              </span>
            </DespachoGateButton>
            <button onClick={() => setShowCancelModal(true)} aria-label="Marcar como cancelado" className="inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl bg-red/15 text-red border border-red/25 font-bold text-sm active:scale-[0.97] transition-transform">
              <XCircle size={16} aria-hidden="true" /> Canceló
            </button>
            <button onClick={() => handleMark('noresp')} aria-label="Marcar como no contestó" className="inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl bg-muted text-muted-foreground font-bold text-sm active:scale-[0.97] transition-transform">
              <PhoneOff size={16} aria-hidden="true" /> No contestó
            </button>
          </div>
        ) : (
          <div className="text-center py-3 text-sm font-semibold inline-flex items-center gap-1.5 justify-center w-full">
            {o.result === 'conf' ? <><CheckCircle2 size={16} className="text-green" aria-hidden="true" /> Confirmado</> : o.result === 'canc' ? <><XCircle size={16} className="text-red" aria-hidden="true" /> Cancelado</> : <><PhoneOff size={16} aria-hidden="true" /> No respondió</>}
          </div>
        )}
        </div>
      </div>

      {/* Notas y recordatorios del cliente — visible para toda la tienda.
          Por phone (no solo orderId): si el mismo cliente tiene otro pedido,
          la asesora ve la nota previa que dejó otra compañera. */}
      {o.dbId && (
        <div className="mb-4">
          <NotesPanel phone={o.phone} orderId={o.dbId} variant="compact" />
        </div>
      )}

      {showCancelModal && (
        <div
          className="fixed inset-0 bg-black/70 z-[2000] flex items-end justify-center"
          onClick={() => { setShowCancelModal(false); setCancelOtroMode(false); setCancelOtroText(''); }}
        >
          <div className="bg-surface rounded-t-2xl p-6 pb-[calc(24px+env(safe-area-inset-bottom))] w-full max-w-[480px] max-h-[80vh] overflow-y-auto animate-slide-up" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold mb-4 inline-flex items-center gap-2">
              <XCircle size={18} className="text-red" /> Motivo de cancelación
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
                      className="w-full text-left py-3 px-4 rounded-lg bg-muted text-muted-foreground font-semibold text-sm hover:bg-muted/80 transition-colors"
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
                  className="w-full rounded-lg border border-border bg-background p-3 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => { setCancelOtroMode(false); setCancelOtroText(''); }}
                    className="py-3 px-4 rounded-lg bg-muted text-muted-foreground font-semibold text-sm hover:bg-muted/80 transition-colors"
                  >
                    Volver
                  </button>
                  <button
                    disabled={!cancelOtroText.trim()}
                    onClick={() => handleMark('canc', cancelOtroText.trim())}
                    className="py-3 px-4 rounded-lg bg-red/15 text-red border border-red/25 font-bold text-sm hover:bg-red/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Confirmar cancelación
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {editingOrder && (
        <EditOrderDialog
          open={!!editingOrder}
          onOpenChange={(op) => { if (!op) setEditingOrder(null); }}
          order={editingOrder}
          onSuccess={async () => {
            // BUG 4 fix: re-fetch del pedido editado para refrescar pantalla.
            if (!editingOrder?.dbId) return;
            const { data } = await supabase.from('orders').select(ORDER_COLUMNS).eq('id', editingOrder.dbId).maybeSingle();
            if (data) {
              const updated = dbToOrderData(data as unknown as Parameters<typeof dbToOrderData>[0], 0);
              const merged = allOrders.map(ord => ord.dbId === updated.dbId
                ? { ...ord, ...updated, result: ord.result, reason: ord.reason, retryCount: ord.retryCount }
                : ord);
              setAllOrders(merged);
              buildWorkQueue(merged);
            }
          }}
        />
      )}

      {carrierOrder && (
        <ChangeCarrierDialog
          open={!!carrierOrder}
          onOpenChange={(op) => { if (!op) setCarrierOrder(null); }}
          order={carrierOrder}
          onSuccess={async () => {
            // Re-fetch del pedido para reflejar la nueva transportadora.
            if (!carrierOrder?.dbId) return;
            const { data } = await supabase.from('orders').select(ORDER_COLUMNS).eq('id', carrierOrder.dbId).maybeSingle();
            if (data) {
              const updated = dbToOrderData(data as unknown as Parameters<typeof dbToOrderData>[0], 0);
              const merged = allOrders.map(ord => ord.dbId === updated.dbId
                ? { ...ord, ...updated, result: ord.result, reason: ord.reason, retryCount: ord.retryCount }
                : ord);
              setAllOrders(merged);
              buildWorkQueue(merged);
            }
          }}
        />
      )}
    </>
  );
}
