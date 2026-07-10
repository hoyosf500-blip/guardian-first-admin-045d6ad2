import { useState, useEffect, useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, normalizePhoneForCountry } from '@/lib/orderUtils';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { formatCOP } from '@/lib/utils';
import { parseValorInput } from '@/lib/orderAlerts';
import { buildUpdatePlan, linesDirty, deriveTotal, type EditableLine, type EditStep } from '@/lib/orderEditPlan';
import CustomerForm, { buildCustomerInitial, customerDirty, type CustomerFormState } from '@/components/confirmar/CustomerForm';
import CarrierPicker, { type CarrierOption } from '@/components/confirmar/CarrierPicker';
import ProductLinesEditor, { draftToLine, type LineDraft } from '@/components/confirmar/ProductLinesEditor';
import { toast } from 'sonner';
import { Loader2, Pencil, Truck, Lock } from 'lucide-react';

// "Edición de orden" unificada estilo panel Dropi: datos del cliente +
// dirección | transportadora cotizada en vivo | producto (cantidad/precio) +
// total a recaudar — UN solo botón "Actualizar Orden". Reemplaza a los viejos
// EditOrderDialog / ChangeCarrierDialog / ChangeValueDialog.
//
// La orquestación del submit vive en buildUpdatePlan (src/lib/orderEditPlan):
//  - datos del cliente → dropi-update-order-full (PUT, conserva el ID) SIEMPRE
//    PRIMERO, así la recreación posterior nace con los datos frescos.
//  - transportadora y/o líneas → dropi-change-carrier mode apply_edit (UNA
//    recreación; el pedido queda con ID NUEVO, la ficha local se actualiza sola).
//  - solo valor → mode apply_value (intenta el PUT directo que conserva el ID).
// Cada paso deja Dropi+DB coherentes por sí solo; si un paso falla, el toast
// dice EXACTAMENTE qué quedó aplicado y qué no, y el retry solo re-ejecuta lo
// pendiente (el baseline de datos se resetea al aplicarse).

interface QuoteLineResp {
  dropiId?: number | string;
  quantity?: number | string;
  price?: number | string;
  name?: string;
}

interface QuoteResponse {
  ok?: boolean;
  error?: string;
  current?: string;
  options?: CarrierOption[];
  lines?: QuoteLineResp[];
  total?: number;
  dropiBody?: unknown;
}

interface ApplyResponse {
  ok?: boolean;
  error?: string;
  editApplied?: boolean;
  valorApplied?: boolean;
  /** true = la orden vieja quedó REEMPLAZADA (soft-delete) en Dropi, como hace su panel.
   *  undefined = función deployada vieja (sin el PUT de reemplazo) → puede duplicar. */
  oldReplaced?: boolean;
  method?: string;
  externalId?: string;
  oldExternalId?: string;
  transportadora?: string;
  valor?: number;
  warning?: string;
  dropiHttpStatus?: number;
  dropiBody?: unknown;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderData;
  /** Pre-carga el "Total a recaudar" (ej. total de Shopify desde el chip de sobreprecio). */
  suggestedTotal?: number;
  onSuccess?: () => void;
}

const normCarrier = (s: string | null | undefined) => String(s || '').trim().toUpperCase();

/** Descripción de error con el body crudo de Dropi (patrón <details> existente). */
function dropiErrorDescription(shortMsg: string, status?: number, body?: unknown) {
  return (
    <div className="space-y-2">
      <p className="text-xs">{shortMsg}</p>
      {(status !== undefined || body !== undefined) && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold">Detalle técnico</summary>
          <pre className="font-mono text-[11px] mt-1 p-2 bg-muted/40 rounded border border-border whitespace-pre-wrap break-all max-h-48 overflow-auto">
{`HTTP ${status ?? 'n/a'}\n\n${JSON.stringify(body ?? {}, null, 2)}`}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function OrderEditorDialog({ open, onOpenChange, order, suggestedTotal, onSuccess }: Props) {
  const { isAdmin } = useAuth();
  const { activeStore } = useStore();
  const countryCode = activeStore?.country_code;

  // Guía generada o pedido ya gestionado: transportadora/líneas/valor fijos.
  const rightEnabled = !order.guia && !order.result;

  const [form, setForm] = useState<CustomerFormState>(() => buildCustomerInitial(order));
  // Baseline resetteable: tras aplicar los datos, el retry no los re-manda.
  const [initial, setInitial] = useState<CustomerFormState>(() => buildCustomerInitial(order));

  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [options, setOptions] = useState<CarrierOption[] | null>(null);
  const [drafts, setDrafts] = useState<LineDraft[] | null>(null);
  /** true = el quote respondió pero SIN líneas (función vieja deployada). */
  const [quoteHadNoLines, setQuoteHadNoLines] = useState(false);

  const [selectedCarrier, setSelectedCarrier] = useState<CarrierOption | null>(null);
  const [overrideRaw, setOverrideRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [requoting, setRequoting] = useState(false);

  const fetchQuote = useCallback(async (withLines?: EditableLine[]) => {
    if (!order.externalId) return;
    if (withLines) setRequoting(true);
    else { setQuoteLoading(true); setQuoteError(null); setOptions(null); }
    try {
      const { data, error } = await supabase.functions.invoke('dropi-change-carrier', {
        body: {
          externalId: order.externalId,
          mode: 'quote',
          ...(withLines ? { lines: withLines.map(l => ({ dropiId: l.dropiId, quantity: l.quantity, price: l.price })) } : {}),
        },
      });
      const d = (data as QuoteResponse | null) ?? null;
      if ((error && !d) || !d?.ok) {
        setQuoteError(d?.error || (error instanceof Error ? error.message : 'No se pudo cotizar con Dropi.'));
        return;
      }
      setQuoteError(null);
      setOptions(d.options || []);
      if (!withLines) {
        // Carga inicial: armar los drafts editables desde las líneas del quote.
        const lines = Array.isArray(d.lines) ? d.lines : null;
        if (lines && lines.length > 0) {
          setDrafts(lines.map((l) => {
            const price = Number(l.price) || 0;
            const quantity = Number(l.quantity) || 1;
            return {
              dropiId: Number(l.dropiId),
              name: l.name ? String(l.name) : undefined,
              quantity,
              priceRaw: String(price),
              basePrice: price,
              baseQuantity: quantity,
            };
          }));
          setQuoteHadNoLines(false);
        } else {
          setDrafts(null);
          setQuoteHadNoLines(true);
        }
      }
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'Error inesperado al cotizar.');
    } finally {
      if (withLines) setRequoting(false);
      else setQuoteLoading(false);
    }
  }, [order.externalId]);

  // Reset completo al abrir (posiblemente con otro pedido) + quote inicial.
  useEffect(() => {
    if (!open) return;
    const init = buildCustomerInitial(order);
    setForm(init);
    setInitial(init);
    setSelectedCarrier(null);
    setOverrideRaw(suggestedTotal != null ? String(suggestedTotal) : '');
    setDrafts(null);
    setQuoteHadNoLines(false);
    setQuoteError(null);
    setOptions(null);
    if (rightEnabled) void fetchQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.externalId]);

  // ---- Flags de cambios ----
  const clientDirty = customerDirty(initial, form);
  const carrierChanged = selectedCarrier != null &&
    normCarrier(selectedCarrier.name) !== normCarrier(order.transportadora);
  const effectiveLines: EditableLine[] | null = drafts ? drafts.map(draftToLine) : null;
  const baseLines: EditableLine[] | null = drafts
    ? drafts.map(d => ({ dropiId: d.dropiId, quantity: d.baseQuantity, price: d.basePrice }))
    : null;
  const linesChanged = !!(effectiveLines && baseLines && linesDirty(baseLines, effectiveLines));
  const overrideParsed = overrideRaw.trim() ? parseValorInput(overrideRaw) : null;
  const overrideValid = overrideParsed != null && overrideParsed > 0;
  const overrideInvalid = overrideRaw.trim() !== '' && !overrideValid;
  const anyPriceInvalid = !!drafts?.some(d => d.priceRaw.trim() !== '' && parseValorInput(d.priceRaw) == null);
  // Total final: override manual > suma de líneas SOLO si se tocaron > valor actual.
  // (Sin esto, un pedido cuyo total_order difiere de la suma de líneas —descuento
  // a nivel de orden— aparecería "cambiado" con solo abrir el diálogo.)
  const currentValor = Number(order.valor) || 0;
  const finalTotal = deriveTotal(
    linesChanged ? effectiveLines : null,
    overrideValid ? overrideParsed : null,
    countryCode,
    currentValor,
  );
  const valorChanged = Math.abs(finalTotal - currentValor) > 0.009;

  const plan: EditStep[] = buildUpdatePlan({
    clientDirty,
    carrierChanged,
    linesChanged,
    valorChanged,
    hasGuia: Boolean(order.guia),
    isManaged: Boolean(order.result),
  });

  const canSubmit = plan.length > 0 && !submitting && !overrideInvalid && !anyPriceInvalid;

  // ---- Pasos del submit ----

  const runUpdateFull = async (): Promise<boolean> => {
    if (!form.nombre.trim()) { toast.error('Nombre obligatorio'); return false; }
    if (!form.direccion.trim()) { toast.error('Dirección obligatoria'); return false; }
    if (!form.ciudad.trim()) { toast.error('Ciudad obligatoria'); return false; }
    if (!form.departamento.trim()) { toast.error('Departamento obligatorio'); return false; }
    if (form.phone && (form.phone.length < 7 || form.phone.length > 15)) {
      toast.error('Teléfono inválido (7-15 dígitos)'); return false;
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      toast.error('Email inválido'); return false;
    }
    const phoneToSend = normalizePhoneForCountry(form.phone, countryCode) ?? form.phone;
    const { data, error } = await supabase.functions.invoke('dropi-update-order-full', {
      body: {
        externalId: order.externalId,
        nombre: form.nombre.trim(),
        apellido: form.apellido.trim(),
        phone: phoneToSend,
        ciudad: form.ciudad.trim(),
        departamento: form.departamento.trim(),
        direccion: form.direccion.trim(),
        email: form.email.trim(),
      },
    });
    const d = (data as { ok?: boolean; error?: string; noChange?: boolean; dropiHttpStatus?: number; dropiBody?: unknown } | null) ?? null;
    const failed = (error && !d) || d?.ok === false ||
      (typeof d?.dropiHttpStatus === 'number' && d.dropiHttpStatus >= 400);
    if (failed) {
      const shortMsg = d?.error || (error instanceof Error ? error.message : 'Error desconocido');
      toast.error('No se guardó nada — Dropi rechazó los datos del cliente', {
        description: dropiErrorDescription(shortMsg, d?.dropiHttpStatus, d?.dropiBody),
        duration: 15000,
      });
      return false;
    }
    // Baseline reset: si un paso posterior falla, el retry no re-manda los datos.
    setInitial({ ...form });
    return true;
  };

  const partialPrefix = (clientApplied: boolean) =>
    clientApplied ? 'Datos del cliente: GUARDADOS ✓ · ' : '';

  const runApplyEdit = async (clientApplied: boolean): Promise<ApplyResponse | null> => {
    const { data, error } = await supabase.functions.invoke('dropi-change-carrier', {
      body: {
        externalId: order.externalId,
        mode: 'apply_edit',
        ...(carrierChanged && selectedCarrier
          ? { distributionCompanyId: selectedCarrier.id, name: selectedCarrier.name }
          : {}),
        ...(linesChanged && effectiveLines
          ? { newLines: effectiveLines.map(l => ({ dropiId: l.dropiId, quantity: l.quantity, price: l.price })) }
          : {}),
        ...(overrideValid ? { newValor: overrideParsed } : {}),
      },
    });
    const d = (data as ApplyResponse | null) ?? null;
    if ((error && !d) || !d?.ok) {
      const shortMsg = d?.error || (error instanceof Error ? error.message : 'Error desconocido');
      // Título según lo que REALMENTE llevaba este intento — el label fijo
      // "Transportadora/cantidades/valor" confundía cuando solo se tocó el
      // precio (la asesora leía que la transportadora también falló).
      const intentado = [
        ...(carrierChanged && selectedCarrier ? ['Transportadora'] : []),
        ...(linesChanged && effectiveLines ? ['Cantidades/precios'] : []),
        ...(overrideValid ? ['Valor'] : []),
      ].join(' + ') || 'La edición';
      toast.error(`${partialPrefix(clientApplied)}${intentado}: NO se aplicó en Dropi`, {
        description: dropiErrorDescription(
          `${shortMsg} — Corregí y tocá "Actualizar Orden": solo se reintenta lo pendiente.`,
          d?.dropiHttpStatus, d?.dropiBody,
        ),
        duration: 15000,
      });
      return null;
    }
    if (d.editApplied !== true) {
      // Función vieja deployada: apply_edit cayó al modo quote (read-only, no mutó).
      toast.error(
        `${clientApplied ? 'Los datos del cliente SÍ quedaron guardados. ' : ''}La función del servidor está desactualizada: NO aplicó transportadora/cantidades. Pedí el redeploy de dropi-change-carrier en Lovable.`,
        { duration: 15000 },
      );
      return null;
    }
    return d;
  };

  const runApplyValue = async (clientApplied: boolean): Promise<ApplyResponse | null> => {
    const { data, error } = await supabase.functions.invoke('dropi-change-carrier', {
      body: { externalId: order.externalId, mode: 'apply_value', newValor: finalTotal },
    });
    const d = (data as ApplyResponse | null) ?? null;
    if ((error && !d) || !d?.ok) {
      const shortMsg = d?.error || (error instanceof Error ? error.message : 'Error desconocido');
      toast.error(`${partialPrefix(clientApplied)}Valor: NO se aplicó`, {
        description: dropiErrorDescription(
          `${shortMsg} — Corregí y tocá "Actualizar Orden": solo se reintenta lo pendiente.`,
          d?.dropiHttpStatus, d?.dropiBody,
        ),
        duration: 15000,
      });
      return null;
    }
    if (d.valorApplied !== true) {
      toast.error(
        `${clientApplied ? 'Los datos del cliente SÍ quedaron guardados. ' : ''}La función del servidor está desactualizada: no aplicó el valor. Pedí el redeploy de dropi-change-carrier en Lovable.`,
        { duration: 15000 },
      );
      return null;
    }
    return d;
  };

  const handleSubmit = async () => {
    if (!order.externalId) {
      toast.error('Este pedido no tiene ID externo de Dropi y no puede sincronizarse');
      return;
    }
    setSubmitting(true);
    try {
      const steps = plan;
      let clientApplied = false;
      let applyResult: ApplyResponse | null = null;
      for (const step of steps) {
        if (step === 'update_full') {
          const ok = await runUpdateFull();
          if (!ok) return;
          clientApplied = true;
        } else if (step === 'apply_edit') {
          applyResult = await runApplyEdit(clientApplied);
          if (!applyResult) return;
        } else if (step === 'apply_value') {
          applyResult = await runApplyValue(clientApplied);
          if (!applyResult) return;
        }
      }

      // Toast final: nombra exactamente qué quedó aplicado.
      if (applyResult) {
        const idChanged = applyResult.method === 'recreate' && applyResult.externalId;
        const parts = [
          clientApplied ? 'datos guardados' : null,
          applyResult.transportadora ? `transportadora ${applyResult.transportadora}` : null,
          applyResult.valor != null ? `total ${formatCOP(applyResult.valor)}` : null,
        ].filter(Boolean).join(' · ');
        toast.success(
          idChanged
            ? `Orden actualizada (${parts}) — quedó con ID nuevo #${applyResult.externalId}`
            : `Orden actualizada (${parts})`,
        );
        if (applyResult.warning) toast.warning(applyResult.warning, { duration: 12000 });
        // Función deployada VIEJA (sin el PUT REEMPLAZADA): la orden vieja queda viva
        // en Dropi → duplicado. Con la función nueva, oldReplaced viene true/false y
        // el caso false ya llega explicado en applyResult.warning.
        if (applyResult.method === 'recreate' && applyResult.oldReplaced === undefined) {
          toast.warning(
            `La función del servidor no marcó la orden vieja #${applyResult.oldExternalId} como REEMPLAZADA (falta el redeploy de dropi-change-carrier): puede quedar duplicada en Dropi — cancelala en el panel.`,
            { duration: 15000 },
          );
        }
      } else if (clientApplied) {
        toast.success('Orden actualizada y sincronizada con Dropi');
      }
      onSuccess?.();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const productUnavailableNote = drafts
    ? null
    : quoteLoading
      ? null
      : quoteError
        ? 'No se pudieron cargar los productos (falló la cotización). Podés ajustar el total a mano igual.'
        : quoteHadNoLines
          ? 'Para editar cantidades/precios hace falta el redeploy de dropi-change-carrier (todo lo demás funciona igual).'
          : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(op) => {
        // No cerrar a mitad de la cadena de actualización.
        if (submitting && !op) return;
        onOpenChange(op);
      }}
    >
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Pencil size={18} className="text-primary" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle className="text-lg">Edición de orden</DialogTitle>
              <DialogDescription className="text-xs">
                #{order.externalId} · los cambios se sincronizan con Dropi
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-2">
          {/* ---- Columna izquierda: cliente + dirección ---- */}
          <CustomerForm value={form} onChange={setForm} isAdmin={isAdmin} />

          {/* ---- Columna derecha: transportadora + producto + total ---- */}
          <div className="space-y-5">
            {!rightEnabled ? (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
                <Lock size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>
                  {order.guia
                    ? 'Este pedido ya tiene guía generada: la transportadora, las cantidades y el valor quedaron fijos. Solo se pueden editar los datos del cliente.'
                    : 'Este pedido ya fue gestionado: solo se pueden editar los datos del cliente.'}
                </span>
              </div>
            ) : (
              <>
                <section className="space-y-3">
                  <header className="flex items-center gap-2 pb-2 border-b border-border">
                    <Truck size={14} className="text-muted-foreground" aria-hidden="true" />
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Transportadora
                    </h3>
                  </header>
                  <CarrierPicker
                    options={options}
                    loading={quoteLoading}
                    error={quoteError}
                    currentName={order.transportadora || ''}
                    selected={selectedCarrier}
                    onSelect={setSelectedCarrier}
                    onRetry={() => void fetchQuote()}
                  />
                </section>

                <ProductLinesEditor
                  drafts={drafts}
                  loading={quoteLoading}
                  unavailableNote={productUnavailableNote}
                  onPatch={(dropiId, patch) => {
                    setDrafts(prev => prev
                      ? prev.map(d => (d.dropiId === dropiId ? { ...d, ...patch } : d))
                      : prev);
                  }}
                  overrideRaw={overrideRaw}
                  onOverrideRaw={setOverrideRaw}
                  finalTotal={finalTotal}
                  currentValor={currentValor}
                  linesChanged={linesChanged}
                  onRequote={() => { if (effectiveLines) void fetchQuote(effectiveLines); }}
                  requoting={requoting}
                  productoFallback={order.producto}
                />

                {plan.includes('apply_edit') && (
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Igual que el panel de Dropi: el pedido se recrea con un <strong>ID nuevo</strong> y
                    la orden vieja queda <strong>REEMPLAZADA</strong> al instante — sin duplicados ni en
                    Dropi ni en el CRM (la ficha se actualiza sola).
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            size="lg"
            className="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-6"
          >
            {submitting && <Loader2 size={14} className="mr-2 animate-spin" aria-hidden="true" />}
            {plan.length === 0 ? 'Sin cambios' : 'Actualizar Orden'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
