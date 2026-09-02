import { useMemo } from 'react';
import { ExternalLink, X, CheckCircle2, Clock, Copy as CopyIcon, AlertTriangle } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import type {
  ShopifyPendingItem,
  ShopifyMatchedItem,
  ShopifyDuplicateItem,
} from '@/hooks/useShopifyPending';

/**
 * CUADRE DEL DÍA — la lista de TODOS los pedidos que entraron en Shopify hoy,
 * cada uno con su estado real: ya está en Dropi (con el número de pedido al
 * lado) o todavía no pasó.
 *
 * Por qué existe (2-sep-2026). El dueño escribió: *"en guardian ahora hay 9
 * pero en shopify hay 10, está faltando 1 que el asesor no lo ve"*. Los números
 * del panel eran correctos — pero eran **solo números**, en una tira que pone
 * dos ventanas de tiempo distintas ("Hoy" y "Últimos 7d") con las mismas
 * palabras. Leyó el "9 ya en Dropi" de los 7 días contra el "10 en Shopify" de
 * hoy y concluyó que faltaba uno. No había forma de comprobarlo: la única
 * lista que existía era la de lo que FALTA.
 *
 * ⛔ Y contar filas de Guardian tampoco cuadra nunca, por una razón real:
 * Dropi puede tener DOS pedidos para UNA venta. Ese mismo día, Colombia 2 tenía
 * 10 ventas en Shopify y 8 filas en Guardian = 7 ventas cubiertas + 1 duplicado.
 * Por eso el bloque de duplicados va acá abajo y no escondido en otra pantalla:
 * es la mitad que faltaba para que la resta dé.
 *
 * La regla de esta pantalla: **cada venta de Shopify aparece exactamente una
 * vez**, con una respuesta. Si la suma no da, se dice; no se maquilla.
 */

interface Props {
  /** Día que se está cuadrando (YYYY-MM-DD, zona horaria de la tienda). */
  dia: string;
  /** Cuántas ventas entraron ese día en Shopify, según el servidor. */
  shopifyDelDia: number;
  /** Ya están en Dropi. `undefined` = el servidor todavía no lo manda. */
  matched?: ShopifyMatchedItem[];
  /** Los que faltan pasar (TODOS los del servidor, sin filtrar por navegador). */
  pending: ShopifyPendingItem[];
  /** Pedidos de Dropi que sobran sobre una venta ya cubierta. */
  duplicates?: ShopifyDuplicateItem[];
  /** Zona horaria de la tienda, para agrupar y mostrar la hora. */
  timeZone: string;
  onClose: () => void;
}

type Fila =
  | { tipo: 'en_dropi'; hora: number; item: ShopifyMatchedItem }
  | { tipo: 'sin_pasar'; hora: number; item: ShopifyPendingItem };

export default function CuadreDelDia({
  dia, shopifyDelDia, matched, pending, duplicates, timeZone, onClose,
}: Props) {
  const mismoDia = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone });
    return (iso: string) => fmt.format(new Date(iso)) === dia;
  }, [dia, timeZone]);

  const hora = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('es-CO', { timeZone, hour: '2-digit', minute: '2-digit' });
    return (iso: string) => fmt.format(new Date(iso));
  }, [timeZone]);

  // El detalle todavía no llega del servidor: la edge function `shopify-reconcile`
  // manda `matched` desde el 2-sep-2026 y Lovable NO redespliega edge functions
  // al publicar. Sin ella se puede listar lo que falta, pero NO afirmar el cuadre.
  const sinDetalle = matched === undefined;

  const filas: Fila[] = useMemo(() => {
    const out: Fila[] = [];
    for (const m of matched ?? []) {
      if (mismoDia(m.created_at)) out.push({ tipo: 'en_dropi', hora: new Date(m.created_at).getTime(), item: m });
    }
    for (const p of pending) {
      if (mismoDia(p.created_at)) out.push({ tipo: 'sin_pasar', hora: new Date(p.created_at).getTime(), item: p });
    }
    return out.sort((a, b) => b.hora - a.hora);
  }, [matched, pending, mismoDia]);

  const dupsDelDia = useMemo(
    () => (duplicates ?? []).filter(d => mismoDia(d.created_at)),
    [duplicates, mismoDia],
  );

  const enDropi = filas.filter(f => f.tipo === 'en_dropi').length;
  const sinPasar = filas.filter(f => f.tipo === 'sin_pasar').length;
  // El control que hace que esta pantalla sirva para COMPROBAR: si las filas no
  // suman lo que Shopify dice, hay una venta que no está en ninguna de las dos
  // listas. Es exactamente el miedo del dueño y no se puede tapar.
  const cuadra = !sinDetalle && enDropi + sinPasar === shopifyDelDia;

  const copiar = (t: string) => { void navigator.clipboard?.writeText(t); };

  return (
    <div className="border-t border-border/60 bg-card/40">
      <div className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">Cuadre del día</h3>
        <span className="text-xs text-muted-foreground">
          {shopifyDelDia} {shopifyDelDia === 1 ? 'venta entró' : 'ventas entraron'} en Shopify
          {!sinDetalle && <> · <span className="text-success font-medium">{enDropi} ya en Dropi</span> · <span className={sinPasar > 0 ? 'text-warning font-medium' : ''}>{sinPasar} sin pasar</span></>}
        </span>
        <button
          onClick={onClose}
          aria-label="Cerrar el cuadre del día"
          className="ml-auto h-8 w-8 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {sinDetalle && (
        <p className="mx-4 mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          <AlertTriangle size={13} className="inline mr-1 text-warning" aria-hidden="true" />
          Todavía se ven <strong>solo los que faltan</strong>. El detalle pedido por pedido lo manda
          la función <code>shopify-reconcile</code>, y publicar en Lovable no la actualiza:
          hay que desplegarla. Hasta entonces esta pantalla no puede afirmar que el día cuadra.
        </p>
      )}

      {!sinDetalle && !cuadra && (
        <p className="mx-4 mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground">
          <AlertTriangle size={13} className="inline mr-1 text-destructive" aria-hidden="true" />
          <strong>No cuadra:</strong> Shopify dice {shopifyDelDia} y acá abajo hay {enDropi + sinPasar}.
          Apretá Actualizar; si sigue igual, avisá — hay una venta que no está en ninguna de las dos listas.
        </p>
      )}

      {filas.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">
          {sinDetalle ? 'No hay pedidos sin pasar de este día.' : 'Todavía no entró ninguna venta este día.'}
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {filas.map(f => {
            const it = f.item;
            const ok = f.tipo === 'en_dropi';
            return (
              <li key={`${f.tipo}-${it.id}`} className="px-4 py-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ok ? 'bg-success' : 'bg-warning'}`} aria-hidden="true" />
                <span className="font-mono tabular-nums text-muted-foreground">{hora(it.created_at)}</span>
                <a
                  href={it.admin_url} target="_blank" rel="noopener noreferrer"
                  className="font-semibold text-foreground hover:text-primary inline-flex items-center gap-1"
                  title="Abrir el pedido en Shopify">
                  {it.name} <ExternalLink size={10} aria-hidden="true" />
                </a>
                <span className="text-foreground truncate max-w-[12rem]">{it.customer}</span>
                {it.city && <span className="text-muted-foreground">· {it.city}</span>}
                {it.total > 0 && <span className="tabular-nums text-muted-foreground">· {formatCOP(it.total)}</span>}

                {ok ? (
                  <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-success font-medium">
                    <CheckCircle2 size={11} aria-hidden="true" />
                    en Dropi
                    <button
                      onClick={() => copiar((f.item as ShopifyMatchedItem).external_id)}
                      title="Copiar el número de pedido de Dropi"
                      className="font-mono tabular-nums underline decoration-dotted underline-offset-2 hover:text-foreground inline-flex items-center gap-1">
                      #{(f.item as ShopifyMatchedItem).external_id}
                      <CopyIcon size={9} aria-hidden="true" />
                    </button>
                    <span className="opacity-70 font-normal">· {(f.item as ShopifyMatchedItem).estado}</span>
                  </span>
                ) : (
                  <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning font-semibold">
                    <Clock size={11} aria-hidden="true" /> sin pasar a Dropi
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dupsDelDia.length > 0 && (
        <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
          <p className="text-xs font-semibold text-foreground">
            <AlertTriangle size={13} className="inline mr-1 text-destructive" aria-hidden="true" />
            {dupsDelDia.length === 1
              ? 'Dropi tiene un pedido de MÁS sobre una venta ya cubierta'
              : `Dropi tiene ${dupsDelDia.length} pedidos de MÁS sobre ventas ya cubiertas`}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Se despacharía dos veces al mismo cliente. Hay que borrarlo a mano en Dropi.
          </p>
          <ul className="mt-1.5 space-y-1">
            {dupsDelDia.map(d => (
              <li key={d.external_id} className="text-xs flex flex-wrap items-center gap-x-2">
                <span className="font-mono tabular-nums font-semibold text-foreground">#{d.external_id}</span>
                <span className="text-foreground">{d.nombre}</span>
                {d.ciudad && <span className="text-muted-foreground">· {d.ciudad}</span>}
                <span className="tabular-nums text-muted-foreground">· {formatCOP(d.valor)}</span>
                <span className="text-muted-foreground">· sobra sobre la venta {d.shopify_name}</span>
                <span className="opacity-70 text-muted-foreground">· {d.estado}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
