import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, ChevronRight, Phone as PhoneIcon, MessageSquare,
  Copy, MapPin, Package, DollarSign, Tag, Truck, AlertTriangle,
  CheckCircle, ExternalLink, User, Clock, Send,
} from 'lucide-react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';
import { OrderData, formatPhone, getTrackingUrl, getWhatsAppPhone, calcBusinessDays } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { getAlertLevel } from '@/lib/alertSystem';
import FingerprintBadge from '@/components/FingerprintBadge';
import AddressValidationBadge from '@/components/AddressValidationBadge';
import { AddressFeedbackCard } from '@/components/address/AddressFeedbackCard';
import { heuristicValidate } from '@/lib/addressHeuristic';
import { issuesToMissingFields } from '@/lib/issuesToMissingFields';
import { buildWhatsAppMessage } from '@/lib/buildWhatsAppMessage';
import { buildAddressSuggestion } from '@/lib/buildAddressSuggestion';
import { mapAddressKind } from '@/lib/mapAddressKind';
import { useGoogleAddressLookup } from '@/hooks/useGoogleAddressLookup';
import { TruncatedText } from '@/components/TruncatedText';
import { useSessionState } from '@/hooks/useSessionState';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

// Validador-direcciones: guard fire-once-per-order-per-session — mismo
// patrón que en CallView para que la auto-validación no entre en loop si
// realtime no actualiza la fila inmediatamente.
const autoValidatedOrderIdsCrm = new Set<string>();

// Validador-direcciones: ids con pickup_office override ya aplicado en sesión.
// Mismo patrón que en CallView — evita re-disparar el UPDATE en cada render
// si realtime tarda en refrescar.
const pickupOverrideAppliedIdsCrm = new Set<string>();

// Validador-direcciones: ids con stale-green override aplicado en sesión.
// Pedidos con validation_decision='green' persistido pero la heurística
// stricter actual los marcaría yellow/red. Mismo patrón que pickup override
// pero para detectar stale green tras el fix de placa canónica de b4ccf19.
const staleGreenOverrideIdsCrm = new Set<string>();

const isManaged = (it: OrderData, managed: Record<string, string>): boolean =>
  !!(it.dbId && managed[it.dbId]);

interface Touchpoint {
  id: string;
  phone: string;
  action: string;
  action_date: string;
  action_time: string | null;
  operator_id: string;
  created_at: string;
}

interface Props {
  items: OrderData[];
  actions: string[];
  managed: Record<string, string>;
  phoneTouchpoints: Record<string, Touchpoint[]>;
  getOperatorName: (id: string) => string;
  onAction: (order: OrderData, action: string) => void;
  /** Unique key for sessionStorage (e.g. "seg" or "rescue"). */
  storageKey: string;
  module: string;
}

function getOrderStatusAgeDays(order: OrderData): number {
  // Keep in sync with CrmTable.getOrderStatusAgeDays — usa calcBusinessDays
  // (excluye sábados, domingos y festivos colombianos) en vez de aproximación
  // *5/7 sobre días calendario, que sub-contaba en semanas con festivos.
  const baseDate = (order.fechaConf || order.fecha || '').trim();
  if (baseDate && baseDate !== 'undefined') {
    return calcBusinessDays(baseDate);
  }
  return order.diasConf || order.dias || 0;
}

function isExcludedFromDelay(estado: string): boolean {
  const e = estado.toUpperCase();
  return e === 'ENTREGADO' || e.includes('DEVOL') || e === 'CANCELADO' || e === 'RECHAZADO';
}

/**
 * Call-center style view for Seguimiento / Rescate: shows one order at a
 * time with full detail and quick action buttons, the same ergonomics as
 * the Confirmar tab's Llamar view. Especially useful when filtering by a
 * status like "Reclame en oficina" — instead of scrolling through a column
 * the operator works the list one order at a time.
 */
export default function CrmCallView({
  items, actions, managed, phoneTouchpoints, getOperatorName, onAction, storageKey, module,
}: Props) {
  const { isAdmin } = useAuth();
  // BUG B fix: persist the *order id* of the customer being attended, not
  // the array index. When `items` reorders (refresh, sync, filter change)
  // the index points to a different customer; the id stays stable.
  const [callOrderId, setCallOrderId] = useSessionState<string | null>(
    `crmcall:${storageKey}:callOrderId`,
    null,
  );

  const keyOf = (it: OrderData) => it.externalId || it.dbId || it.phone;

  // Derive the index from the stored id every render.
  let derivedIdx = callOrderId ? items.findIndex((it) => keyOf(it) === callOrderId) : -1;
  if (derivedIdx < 0) {
    const firstUnmanaged = items.findIndex((it) => !isManaged(it, managed));
    derivedIdx = firstUnmanaged >= 0 ? firstUnmanaged : 0;
  }

  // Only re-seed when the stored customer is gone (or never set).
  useEffect(() => {
    if (!items.length) return;
    const exists = callOrderId && items.some((it) => keyOf(it) === callOrderId);
    if (!exists) {
      const firstUnmanaged = items.findIndex((it) => !isManaged(it, managed));
      const target = items[firstUnmanaged >= 0 ? firstUnmanaged : 0];
      const k = target ? keyOf(target) : null;
      if (k && k !== callOrderId) setCallOrderId(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOrderId, items]);

  // Validador-direcciones: orderIds con auto-validación EN VUELO. Alimenta el
  // prop `loading` de AddressFeedbackCard para evitar que se quede pulsando
  // "Validando..." cuando la edge function no resuelve.
  const [validatingOrderIds, setValidatingOrderIds] = useState<Set<string>>(() => new Set());

  // Validador-direcciones: cache en-memoria de sugerencias de Google Places
  // por orderId. Mismo patrón que CallView — la columna DB suggested_address
  // está pendiente (HOTFIX 2026-04-30), así que la guardamos en estado para
  // priorizarla sobre la heurística local cuando renderizamos la card.
  const [googleSuggestions, setGoogleSuggestions] = useState<Record<string, string>>({});

  // Validador-direcciones: auto-validar pedido pre-feature al verlo.
  // Mismo patrón que en CallView — pedidos con validation_decision=null
  // que tienen dirección razonable se validan en background una vez por
  // sesión; el resultado se persiste y realtime refresca la card.
  // Hook colocado ANTES del early-return para no violar reglas de hooks.
  const previewIdx = items.length
    ? Math.max(0, Math.min(derivedIdx, items.length - 1))
    : -1;
  const previewOrder = previewIdx >= 0 ? items[previewIdx] : undefined;
  const previewDbId = previewOrder?.dbId;
  const previewDecision = previewOrder?.validationDecision ?? null;
  const previewMissingFields = previewOrder?.missingFields;
  const previewDireccion = previewOrder?.direccion ?? '';
  const previewCiudad = previewOrder?.ciudad ?? '';
  const previewDept = previewOrder?.departamento ?? '';
  const previewNombre = previewOrder?.nombre ?? '';
  const previewProducto = previewOrder?.producto ?? '';
  const previewManaged = previewOrder?.dbId ? Boolean(managed[previewOrder.dbId]) : false;

  useEffect(() => {
    if (!previewDbId) return;
    // Skip si decision terminal y completa:
    //   - green/pickup_office: no necesitan missing_fields
    //   - red/yellow con missing_fields ya poblados (caso normal post-fix)
    // Re-disparar si:
    //   - decision === null (pedido pre-feature, sin validar)
    //   - decision red/yellow PERO missing_fields vacío (pedidos validados
    //     ANTES del fix de issuesToMissingFields que tienen missing_fields=[])
    const isGreenOrPickup = previewDecision === 'green' || previewDecision === 'pickup_office';
    const isRedOrYellowMissingFields =
      (previewDecision === 'red' || previewDecision === 'yellow') &&
      (!previewMissingFields || previewMissingFields.length === 0);
    const shouldValidate = previewDecision === null || isRedOrYellowMissingFields;
    if (isGreenOrPickup || !shouldValidate) return;
    if (!previewDireccion || previewDireccion.trim().length < 5) return;
    if (previewManaged) return;
    // Backfill retry: si el id está marcado como ya-validado en sesión PERO
    // missing_fields quedó vacío con decision red/yellow, removerlo del Set
    // para permitir un retry. Esto cubre pedidos que se persistieron con
    // decision pero sin missing_fields antes del fix de issuesToMissingFields.
    if (
      previewDbId &&
      autoValidatedOrderIdsCrm.has(previewDbId) &&
      (previewDecision === 'red' || previewDecision === 'yellow') &&
      (!previewMissingFields || previewMissingFields.length === 0)
    ) {
      autoValidatedOrderIdsCrm.delete(previewDbId);
    }
    if (autoValidatedOrderIdsCrm.has(previewDbId)) return;

    const orderId = previewDbId;
    const direccion = previewDireccion;
    const ciudad = previewCiudad;
    const departamento = previewDept;
    // Snapshot nombre/producto para el WhatsApp builder dentro de async closures.
    const nombre = previewNombre;
    const producto = previewProducto;
    autoValidatedOrderIdsCrm.add(orderId);

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
    // Fallback heurístico tras 3s. El badge SIEMPRE termina en green/yellow/red
    // — sin Google ni Haiku, lógica 100% local.
    const fallbackTimerId = setTimeout(() => {
      if (cancelled || edgeReturned) return;
      void runHeuristicFallback();
    }, 3_000);
    const hardStopTimerId = setTimeout(() => {
      cancelled = true;
      stopLoading();
    }, 10_000);

    const decisionFromHeuristic = (score: number): 'green' | 'yellow' | 'red' => {
      if (score >= 80) return 'green';
      if (score >= 50) return 'yellow';
      return 'red';
    };

    const runHeuristicFallback = async () => {
      if (cancelled) return;
      const result = heuristicValidate(direccion);
      const decision = result.decision ?? decisionFromHeuristic(result.score);
      const address_kind = result.address_kind ?? null;
      // Para pickup_office la heurística devuelve missing_fields=[] explícito
      // — respetar y NO derivar de issues. Para el resto, traducir issues[] a
      // campos concretos (placa/barrio/complemento) y generar el mensaje
      // WhatsApp listo para copiar.
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
      } catch {
        // best-effort
      } finally {
        if (!cancelled) stopLoading();
      }
    };

    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke<{
          decision?: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
          address_kind?: 'urban' | 'rural' | 'pickup_office' | 'unknown' | null;
          missing_fields?: string[];
          suggested_customer_message?: string;
          suggested_address?: string | null;
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
        // pendiente de migration (hotfix 7aa41fd la comentó). Sin esto la
        // sugerencia se perdería al re-render. Tiene mejor calidad que la
        // heurística local porque viene de la base real de Google.
        if (data.suggested_address) {
          setGoogleSuggestions((prev) => ({ ...prev, [orderId]: data.suggested_address! }));
        }
        // Si Haiku/edge function ya devolvió missing_fields y mensaje, los
        // preservamos. Si NO los devolvió, derivamos localmente para que la
        // operadora SIEMPRE vea qué falta + un mensaje WhatsApp listo.
        let final_missing_fields = data.missing_fields;
        let final_suggested_message = data.suggested_customer_message;
        if (final_missing_fields === undefined || final_suggested_message === undefined) {
          const heur = heuristicValidate(direccion);
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
  }, [previewDbId, previewDecision, previewMissingFields, previewDireccion, previewCiudad, previewDept, previewNombre, previewProducto, previewManaged]);

  // Validador-direcciones: pickup override client-side.
  // Mismo patrón que en CallView — si mapAddressKind detecta pickup_office
  // pero la DB tiene otro decision (ej. green stale persistido por la edge
  // function vieja antes del fix de regex pickup), corregir DB con UPDATE
  // directo sin llamar a la edge function. La decisión es 100% client-side
  // basada en regex de keywords; no quema cuota Google. Idempotente vía Set
  // módulo-level.
  useEffect(() => {
    if (!previewDbId || !previewDireccion) return;
    if (previewDecision === 'pickup_office') return; // ya correcto
    const detected = mapAddressKind(previewDireccion);
    if (detected !== 'pickup_office') return;
    if (pickupOverrideAppliedIdsCrm.has(previewDbId)) return;
    pickupOverrideAppliedIdsCrm.add(previewDbId);
    void supabase
      .from('orders')
      .update({
        validation_decision: 'pickup_office',
        address_kind: 'pickup_office',
        missing_fields: [],
        suggested_customer_message: '',
      })
      .eq('id', previewDbId);
  }, [previewDbId, previewDireccion, previewDecision]);

  // Validador-direcciones: stale-green override client-side.
  // Espejo del de CallView. Si DB tiene green pero la heurística stricter
  // actual marcaría yellow/red (caso real Brayan Uni — "Cll4 13 38
  // Apartamento." sin placa canónica con guion), corregir DB con UPDATE
  // directo. NO llama edge function. Idempotente vía Set módulo-level.
  useEffect(() => {
    if (!previewDbId || !previewDireccion) return;
    if (previewDecision !== 'green') return; // solo green
    if (staleGreenOverrideIdsCrm.has(previewDbId)) return;

    // Pickup override tiene precedencia.
    const detectedKind = mapAddressKind(previewDireccion);
    if (detectedKind === 'pickup_office') return;

    const heur = heuristicValidate(previewDireccion);
    if (heur.decision === 'green') return;

    staleGreenOverrideIdsCrm.add(previewDbId);
    const decision = heur.decision ?? 'yellow';
    const missing_fields = heur.missing_fields ?? issuesToMissingFields(heur.issues ?? []);
    void supabase
      .from('orders')
      .update({
        validation_decision: decision,
        address_kind: heur.address_kind ?? null,
        missing_fields,
        suggested_customer_message: '',
      })
      .eq('id', previewDbId);
  }, [previewDbId, previewDireccion, previewDecision]);

  // Validador-direcciones: Google Places lookup automático.
  // Mismo patrón que en CallView — cuando el pedido está yellow/red,
  // llamamos a la edge function google-places-proxy con la dirección que
  // escribió el cliente y tomamos la primera predicción como sugerencia
  // REAL en el badge, prioritaria sobre la heurística client-side. Cache
  // en memoria por orderId. NOTA: para gatear con visualDecisionCrm
  // (cómputo que vive abajo del early-return) usamos el `previewDecision`
  // crudo + un re-cómputo inline de pickup_office/stale-green — porque
  // el hook DEBE correr antes del early-return para no violar reglas de
  // hooks. La diferencia entre `previewDecision` y `visualDecisionCrm`
  // solo afecta a transiciones (pickup_office detectado client-side antes
  // del UPDATE persista, o stale-green corregido), que se resuelven en
  // 1-2s vía realtime y luego coincidirán.
  const lookupVisualDecision = (() => {
    if (!previewDireccion) return previewDecision;
    const detected = mapAddressKind(previewDireccion);
    if (detected === 'pickup_office') return 'pickup_office' as const;
    if (previewDecision === 'green') {
      const heur = heuristicValidate(previewDireccion);
      if (heur.decision && heur.decision !== 'green') return heur.decision;
    }
    return previewDecision;
  })();
  const lookupEnabledCrm =
    (lookupVisualDecision === 'yellow' || lookupVisualDecision === 'red') && Boolean(previewDbId);
  const { result: googleLookup, loading: lookupLoading } = useGoogleAddressLookup({
    direccion: previewDireccion,
    ciudad: previewCiudad,
    // CRÍTICO: pasar departamento para que el hook descarte resultados que
    // no coincidan con la región del pedido (anti-alucinación de Google).
    departamento: previewDept,
    enabled: lookupEnabledCrm,
    cacheKey: previewDbId ?? 'noid',
  });

  if (!items.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
          <CheckCircle size={20} className="text-emerald-500" />
        </div>
        <h3 className="text-base font-semibold text-foreground">Nada para gestionar</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          No hay pedidos en este filtro. Cambia el filtro o vuelve a la vista Lista.
        </p>
      </div>
    );
  }

  const idx = Math.max(0, Math.min(derivedIdx, items.length - 1));
  const o = items[idx];
  const diasEnEstatus = getOrderStatusAgeDays(o);
  const alert = getAlertLevel(diasEnEstatus, o.dias, o.estado, o.transportadora, o.novedad);
  const trackUrl = getTrackingUrl(o.transportadora, o.guia);
  const currentManaged = o.dbId ? managed[o.dbId] : undefined;
  const tps = phoneTouchpoints[o.phone] || [];
  const isDelayed = diasEnEstatus >= 2 && !isExcludedFromDelay(o.estado);

  const waMsg = encodeURIComponent(
    `Hola ${o.nombre.split(' ')[0]}, te escribo sobre tu pedido${o.guia ? ` (guía ${o.guia})` : ''}. Necesitamos coordinar la entrega.`,
  );

  const goTo = (i: number) => {
    const target = items[Math.max(0, Math.min(items.length - 1, i))];
    if (target) setCallOrderId(keyOf(target));
  };

  const navCall = (dir: number) => goTo(idx + dir);

  const jumpToFirstUnmanaged = () => {
    // Busca primero después de la posición actual.
    let next = items.findIndex((it, i) => i > idx && !isManaged(it, managed));
    // Si no hay, fallback desde el inicio: cubre el caso de pedidos
    // nuevos que llegaron por realtime y se ordenaron antes (más urgentes).
    if (next < 0) next = items.findIndex((it) => !isManaged(it, managed));
    if (next >= 0 && next !== idx) goTo(next);
    else toast.success('Todos los pedidos de la lista están gestionados');
  };

  const handleAction = async (action: string) => {
    onAction(o, action);
    // Jump to next unmanaged after a short delay so the UI can show feedback
    setTimeout(jumpToFirstUnmanaged, 450);
  };

  const copyPhone = () => {
    void copyToClipboard(o.phone, `${o.phone} copiado`);
  };
  const copyGuia = () => {
    if (!o.guia) return;
    void copyToClipboard(o.guia, 'Guía copiada');
  };

  const pColor = diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : diasEnEstatus >= 2 ? 'text-orange-400' : 'text-green-500';
  const pDot = diasEnEstatus >= 5 ? 'bg-red-500' : diasEnEstatus >= 3 ? 'bg-amber-500' : diasEnEstatus >= 2 ? 'bg-orange-400' : 'bg-green-500';

  // Validador-direcciones: pickup + stale-green override visual inmediato.
  // Mientras el effect de override hace el UPDATE + realtime refresca,
  // mostramos la decision corregida localmente para no exponer 1-2s a un
  // valor stale.
  const visualDecisionCrm = (() => {
    if (!o?.direccion) return o?.validationDecision ?? null;
    const detected = mapAddressKind(o.direccion);
    if (detected === 'pickup_office') return 'pickup_office' as const;
    if (o.validationDecision === 'green') {
      const heur = heuristicValidate(o.direccion);
      if (heur.decision && heur.decision !== 'green') return heur.decision;
    }
    return o.validationDecision;
  })();

  return (
    <div>
      {/* Persistent "currently attending" banner — survives tab switches */}
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs">
        <User size={12} className="text-primary" />
        <span className="text-muted-foreground">Atendiendo:</span>
        <span className="font-semibold text-foreground truncate">{o.nombre}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-foreground">{formatPhone(o.phone)}</span>
      </div>
      {/* Nav header */}
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-muted-foreground font-mono">{idx + 1} / {items.length}</span>
        <div className="flex gap-1.5">
          <button
            onClick={() => navCall(-1)}
            disabled={idx <= 0}
            className="px-3 py-1.5 rounded-md bg-card border border-border text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button
            onClick={() => navCall(1)}
            disabled={idx >= items.length - 1}
            className="px-3 py-1.5 rounded-md bg-card border border-border text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={o.phone + '-' + idx}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -12 }}
          transition={{ duration: 0.2 }}
          className="bg-surface border border-border rounded-xl p-5 mb-4 hover:border-border-strong transition-colors duration-200"
        >
          {/* Header: badges */}
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div className={`w-2 h-2 rounded-full ${pDot}`} />
            <span className={`text-xs font-bold ${pColor}`}>
              {diasEnEstatus}d sin movimiento
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted font-semibold uppercase tracking-wide">
              {o.estado}
            </span>
            {o.transportadora && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-500 border border-cyan-500/20 font-semibold inline-flex items-center gap-1">
                <Truck size={10} />
                {o.transportadora}
              </span>
            )}
            {alert && alert.level !== 'ok' && alert.level !== 'watch' && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                alert.level === 'lost' ? 'bg-muted text-muted-foreground' :
                alert.level === 'critical' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                'bg-orange-500/10 text-orange-500 border border-orange-500/20'
              }`}>
                {alert.label}
              </span>
            )}
          </div>

          {/* Dropi fingerprint */}
          <div className="mb-3"><FingerprintBadge phone={o.phone} /></div>

          {/* Customer name + external ID */}
          <div className="text-xl font-bold mb-1 text-foreground">{o.nombre}</div>
          {o.externalId && (
            <a
              href={`/pedido/${o.externalId}`}
              className="inline-block text-[10px] font-mono text-primary hover:underline mb-3"
            >
              #{o.externalId}
            </a>
          )}

          {/* Contact row */}
          <div className="text-sm text-muted-foreground mb-3 leading-relaxed space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <PhoneIcon size={12} />
              <button onClick={copyPhone} className="text-cyan-500 hover:underline font-mono">
                {formatPhone(o.phone)}
              </button>
              <button
                onClick={copyPhone}
                className="p-1 rounded text-muted-foreground/70 hover:text-foreground"
                title="Copiar teléfono"
              >
                <Copy size={10} />
              </button>
              <a
                href={`tel:+57${o.phone}`}
                className="ml-1 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/25 hover:bg-accent/25 no-underline transition-colors duration-200"
              >
                <PhoneIcon size={10} aria-hidden="true" /> Llamar
              </a>
              <a
                href={`https://wa.me/${getWhatsAppPhone(o.phone)}?text=${waMsg}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20 no-underline"
              >
                <MessageSquare size={10} /> WhatsApp
              </a>
            </div>

            {(o.ciudad || o.departamento) && (
              <div className="flex items-center gap-1.5">
                <MapPin size={12} />
                <span>{o.ciudad || '—'}{o.departamento ? `, ${o.departamento}` : ''}</span>
              </div>
            )}

            <div className="flex items-start gap-1.5">
              <Package size={12} className="mt-0.5" />
              <span className="flex-1">
                {o.producto || '—'}{o.cantidad > 1 ? ` × ${o.cantidad}` : ''}
              </span>
              {o.valor > 0 && (
                <span className="inline-flex items-center gap-1 text-foreground font-semibold">
                  <DollarSign size={12} />{formatCOP(o.valor)}
                </span>
              )}
            </div>

            {o.direccion && (
              <div className="flex flex-col gap-1.5 text-xs">
                <div className="flex items-start gap-1.5">
                  <MapPin size={12} className="mt-0.5 text-muted-foreground/60" />
                  <span className="flex-1 text-muted-foreground">{o.direccion}</span>
                  {/* Validación de dirección — heurística + geocoding (Nominatim/OSM).
                      Click en el badge abre popover con detalles y posible
                      ubicación en mapa. Ayuda a la operadora a detectar
                      direcciones mal escritas antes de despachar. */}
                  <AddressValidationBadge
                    direccion={o.direccion}
                    ciudad={o.ciudad}
                    departamento={o.departamento}
                  />
                </div>
                {/* Validador-direcciones v2 (legacy view): solo lectura del
                    feedback estructurado de la edge function — sin autocomplete
                    ni override aplicable, esta vista no maneja la confirmación. */}
                <AddressFeedbackCard
                  decision={visualDecisionCrm}
                  missingFields={o.missingFields ?? []}
                  suggestedAddress={o.suggestedAddress}
                  onApplySuggestion={o.suggestedAddress ? () => {
                    if (!o.dbId) return;
                    void supabase.from('orders').update({
                      direccion: o.suggestedAddress,
                      validation_decision: null, // re-validar con la dirección nueva
                    }).eq('id', o.dbId);
                  } : undefined}
                  addressSuggestion={(() => {
                    // Prioridad 1: Google Places real (lookup async via
                    // useGoogleAddressLookup → edge function google-places-proxy).
                    if (googleLookup) {
                      return {
                        suggested: googleLookup.description,
                        missingNote: null,
                        hasEnoughInfo: true,
                      };
                    }
                    // Prioridad 2: cache local de la edge function
                    // dropi-validate-address (cuando devolvió suggested_address).
                    const googleSuggestion = o.dbId ? googleSuggestions[o.dbId] : undefined;
                    if (googleSuggestion) {
                      return { suggested: googleSuggestion, hasEnoughInfo: true };
                    }
                    // Prioridad 3: heurística client-side (fallback).
                    if (!o.direccion) return null;
                    return buildAddressSuggestion({
                      direccion: o.direccion,
                      ciudad: o.ciudad,
                      departamento: o.departamento,
                      barrio: o.barrio,
                    });
                  })()}
                  isAdmin={isAdmin}
                  carrier={o.transportadora}
                  onOverrideChange={() => { /* legacy, sin gate */ }}
                  loading={Boolean(o.dbId && validatingOrderIds.has(o.dbId))}
                  lookupLoading={lookupLoading}
                />
              </div>
            )}

            {o.guia && (
              <div className="flex items-center gap-2 mt-1">
                <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  <Tag size={10} className="text-muted-foreground/60" />
                  <span className="truncate">{o.guia}</span>
                  <button onClick={copyGuia} className="hover:text-foreground">
                    <Copy size={9} />
                  </button>
                </div>
                {trackUrl && (
                  <a
                    href={trackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-3 py-1 text-[10px] font-bold text-white hover:bg-orange-600 no-underline"
                  >
                    <ExternalLink size={10} /> Rastrear
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Novedad banner */}
          {o.novedad && (
            <div className="p-3 rounded-xl mb-4 text-xs bg-orange-500/10 border border-orange-500/20 flex items-start gap-2">
              <AlertTriangle size={14} className="text-orange-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="text-[10px] font-bold text-orange-600 dark:text-orange-400 uppercase tracking-wide mb-0.5">
                  Novedad de {o.transportadora || 'transportadora'}
                </div>
                <div className="text-foreground leading-relaxed">{o.novedad}</div>
              </div>
            </div>
          )}

          {/* Delay warning */}
          {isDelayed && (
            <div className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 ${
              diasEnEstatus >= 5 ? 'bg-red-500/10 border border-red-500/20' :
              diasEnEstatus >= 3 ? 'bg-amber-500/10 border border-amber-500/20' :
              'bg-orange-400/10 border border-orange-400/20'
            }`}>
              <Clock size={12} className={diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : 'text-orange-400'} />
              <span className={`text-[11px] font-semibold ${diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : 'text-orange-400'}`}>
                {diasEnEstatus}d sin movimiento — {diasEnEstatus >= 5 ? 'Posible pérdida' : diasEnEstatus >= 3 ? 'Llamar + reclamar' : 'Monitorear'}
              </span>
            </div>
          )}

          {/* History */}
          {tps.length > 0 && (
            <div className="mb-4">
              <h4 className="text-[10px] font-semibold text-muted-foreground mb-2 inline-flex items-center gap-1 uppercase tracking-wider">
                <MessageSquare size={10} /> Historial ({tps.length})
              </h4>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {tps.slice(0, 6).map(tp => (
                  <div key={tp.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-card border border-border/20 text-[10px]">
                    <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <User size={9} className="text-primary/70" />
                    </div>
                    <span className="font-semibold text-foreground">{getOperatorName(tp.operator_id)}</span>
                    <span className="text-muted-foreground truncate">{tp.action.replace(/^(SEG|RESCUE): ?/, '')}</span>
                    <span className="ml-auto text-muted-foreground/70 flex-shrink-0">
                      {tp.action_time || ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Managed state or action buttons */}
          {currentManaged ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3">
              <div className="flex items-center gap-2">
                <CheckCircle size={16} className="text-emerald-500" />
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-bold">Gestionado</div>
                  <div className="text-xs text-foreground font-semibold">{currentManaged}</div>
                </div>
              </div>
              <button
                onClick={() => navCall(1)}
                disabled={idx >= items.length - 1}
                className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-40 inline-flex items-center gap-1"
              >
                Siguiente <ChevronRight size={12} />
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {actions.map(a => (
                <button
                  key={a}
                  onClick={() => handleAction(a)}
                  className="inline-flex items-center justify-center gap-1.5 py-3 rounded-lg bg-accent/15 text-accent border border-accent/25 font-semibold text-xs hover:bg-accent/25 active:scale-[0.98] transition-all duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <Send size={13} aria-hidden="true" /> <TruncatedText text={a} maxChars={28} />
                </button>
              ))}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
