import { useMemo } from 'react';
import { ScrollText, Loader2 } from 'lucide-react';
import { useBitacoraDeUnPedido, type EventoDeUnPedido } from '@/hooks/useBitacoraDeUnPedido';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { NOMBRE_EVENTO, duracionLegible, saltoSinMirar } from '@/lib/eventosPedido';

/**
 * Qué hizo cada persona con ESTE pedido, en orden.
 *
 * No reemplaza la línea de tiempo de Dropi ni el registro de gestiones: esos
 * dicen qué le pasó al pedido y qué se marcó. Esto dice lo otro —quién lo
 * abrió, cuánto lo tuvo a la vista, si pasó de largo, si deshizo una marca—
 * que es lo que hasta el 4-sep-2026 no se podía ver por pedido.
 */
const HORA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit',
});
const DIA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota', day: '2-digit', month: 'short',
});

function detalleLegible(e: EventoDeUnPedido): string {
  const d = e.detalle;
  const partes: string[] = [];
  if (e.evento === 'marco' || e.evento === 'deshizo') {
    const r = String(d.result ?? '');
    const nombre = r === 'conf' ? 'confirmado' : r === 'canc' ? 'cancelado' : r === 'noresp' ? 'no respondió' : r;
    if (nombre) partes.push(nombre);
    if (d.reason) partes.push(`«${String(d.reason).slice(0, 80)}»`);
  } else if (e.evento === 'edito') {
    if (d.campos) partes.push(`cambió: ${String(d.campos)}`);
  } else if (e.evento === 'gestiono' || e.evento === 'llamo' || e.evento === 'escribio') {
    if (d.accion) partes.push(String(d.accion).slice(0, 80));
  } else if (e.evento === 'cerro' || e.evento === 'salto') {
    partes.push(duracionLegible(e.msEnPantalla));
    if (e.evento === 'salto' && saltoSinMirar(e.msEnPantalla)) partes.push('de paso');
  }
  return partes.join(' · ');
}

export default function BitacoraPedidoCard({ storeId, externalId }: { storeId: string | null; externalId: string | null | undefined }) {
  const { eventos, estado, truncado } = useBitacoraDeUnPedido(storeId, externalId);
  const { nameOf } = useOperatorNames();

  // `abrio` y su `cerro`/`salto` se muestran como una sola línea: "la abrió,
  // 2 min 14 s, gestionó". Los sueltos quedan tal cual.
  const lineas = useMemo(() => {
    const out: Array<{ key: string; cuando: string; quien: string; que: string; tono: 'normal' | 'salto' | 'deshizo' }> = [];
    for (const e of eventos) {
      if (e.evento === 'abrio') continue; // se cuenta con su cierre
      const fecha = new Date(e.createdAt);
      out.push({
        key: e.id,
        cuando: `${DIA.format(fecha)} ${HORA.format(fecha)}`,
        quien: nameOf(e.operatorId),
        que: `${NOMBRE_EVENTO[e.evento] ?? e.evento}${detalleLegible(e) ? ` — ${detalleLegible(e)}` : ''}`,
        tono: e.evento === 'salto' ? 'salto' : e.evento === 'deshizo' ? 'deshizo' : 'normal',
      });
    }
    return out;
  }, [eventos, nameOf]);

  if (!externalId) return null;

  return (
    <section className="hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d" aria-label="Bitácora del pedido">
      <div className="flex items-center gap-2 mb-3">
        <ScrollText size={16} className="text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">Quién tocó este pedido</h3>
        {estado === 'cargando' && <Loader2 size={12} className="animate-spin text-muted-foreground" aria-hidden="true" />}
      </div>

      {estado === 'not_ready' && (
        <p className="text-xs text-muted-foreground">La bitácora todavía no está prendida en esta base.</p>
      )}
      {estado === 'error' && (
        <p className="text-xs text-danger">No se pudo leer la bitácora de este pedido ahora mismo.</p>
      )}
      {estado === 'ok' && lineas.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Sin registros desde que existe la bitácora (3-sep-2026). Lo anterior a esa fecha no se puede ver acá.
        </p>
      )}
      {estado === 'ok' && lineas.length > 0 && (
        <ol className="space-y-1.5 text-xs">
          {lineas.map((l) => (
            <li key={l.key} className="flex flex-wrap gap-x-2 gap-y-0.5">
              <span className="font-mono tabular-nums text-muted-foreground shrink-0">{l.cuando}</span>
              <span className="font-semibold shrink-0">{l.quien}</span>
              <span className={l.tono === 'salto' ? 'text-warning' : l.tono === 'deshizo' ? 'text-danger' : 'text-foreground/90'}>
                {l.que}
              </span>
            </li>
          ))}
        </ol>
      )}
      {truncado && (
        <p className="mt-2 text-[11px] text-warning">Este pedido tiene más eventos de los que se muestran; la lista está incompleta.</p>
      )}
      <p className="mt-3 text-[10px] text-muted-foreground">
        Si el navegador se cierra de golpe se pierden los últimos segundos: una ausencia acá no prueba que algo no pasó.
      </p>
    </section>
  );
}
