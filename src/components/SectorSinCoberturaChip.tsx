import { memo } from 'react';
import { Building2 } from 'lucide-react';
import { sectorSinCobertura, type CoberturaMedida } from '@/lib/dropiEcuador/logisticaOficial';
import { useCoberturaMedida } from '@/hooks/useCoberturaMedida';

interface Props {
  direccion?: string | null;
  ciudad?: string | null;
  countryCode?: string | null;
}

const fmtT = (c: CoberturaMedida) =>
  c.porTransportadora.map((t) => `${t.transportadora} ${t.entregados}/${t.entregados + t.devueltos}`).join(' · ');

/**
 * Dos voces, en este orden: lo que dice Dropi (aviso) y lo que midió ESTA tienda
 * (manda). La lista oficial de sectores sin cobertura de Servientrega EC es
 * vieja y genérica: auditada contra los pedidos reales, Servientrega entrega
 * igual en la mayoría de esos sectores y solo un puñado se confirma como «no
 * llega». Por eso el chip nunca ordena «ofrecer agencia» solo porque Dropi lo
 * liste: pide la medición de la tienda y recomienda según ese dato.
 *
 * Solo Ecuador (la lista es de Servientrega EC). Cero nunca sustituye a «no se
 * pudo medir»: cargando, error y sin envíos se dicen con esas palabras.
 */
export default memo(function SectorSinCoberturaChip({ direccion, ciudad, countryCode }: Props) {
  const z = countryCode === 'EC' ? sectorSinCobertura(direccion, ciudad) : null;
  // El hook va ANTES del early-return: un hook debajo de un return condicional
  // tumba la pantalla (React #300/#308). Con z=null queda deshabilitado.
  const medida = useCoberturaMedida(z);
  if (!z) return null;
  const ag = z.agenciaDetalle;
  const agencia = z.agencia ?? 'más cercana';
  const m = medida.data;

  let tono = 'border-warning/30 bg-warning/10 text-warning';
  let veredicto: string;
  if (medida.isLoading) {
    veredicto = 'Midiendo los envíos de esta tienda a ese sector…';
  } else if (medida.isError || !m) {
    veredicto = 'No se pudo medir qué pasó con los envíos de esta tienda ahí.';
  } else if (m.veredicto === 'sin_dato') {
    veredicto = m.terminales === 0
      ? 'Esta tienda no tiene envíos terminados a ese sector. Pedir una buena referencia y ofrecer la agencia como opción.'
      : `Esta tienda solo tiene ${m.terminales} envío(s) terminado(s) ahí (${m.entregados} entregado(s)): muy poco para afirmar. Pedir referencia y ofrecer la agencia como opción.`;
  } else if (m.veredicto === 'entregamos') {
    tono = 'border-success/30 bg-success/10 text-success';
    veredicto = `Pero esta tienda SÍ entrega ahí: ${m.entregados} de ${m.terminales} (${fmtT(m)}). Seguir a domicilio.`;
  } else if (m.veredicto === 'regular') {
    veredicto = `Esta tienda entrega ahí a medias: ${m.entregados} de ${m.terminales} (${fmtT(m)}). Pedir buena referencia; agencia como plan B.`;
  } else {
    tono = 'border-danger/30 bg-danger/10 text-danger';
    const alt = m.mejorAlternativa && m.mejorAlternativa !== 'SERVIENTREGA'
      ? ` o despachar con ${m.mejorAlternativa}`
      : '';
    veredicto = `Esta tienda tampoco llega: ${m.entregados} de ${m.terminales} (${fmtT(m)}). Ofrecer retiro en agencia${alt} antes de despachar.`;
  }

  return (
    <span
      className={`inline-flex items-start gap-1.5 rounded-lg border px-2 py-1 text-[11px] leading-snug max-w-full ${tono}`}
      title={`Lista oficial de Servientrega (Dropi, ago-2026): ${z.sector}.${ag ? ` Agencia ${agencia}: ${ag.direccion} (L-V ${ag.horarioLunesViernes}).` : ''}`}
    >
      <Building2 size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <span className="opacity-80">
          Dropi lista {z.sector} sin cobertura a domicilio de Servientrega → agencia {agencia}{ag ? ` (${ag.direccion})` : ''}.
        </span>{' '}
        <strong>{veredicto}</strong>
      </span>
    </span>
  );
});
