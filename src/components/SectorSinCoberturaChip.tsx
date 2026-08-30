import { memo } from 'react';
import { Building2 } from 'lucide-react';
import { sectorSinCobertura } from '@/lib/dropiEcuador/logisticaOficial';

interface Props {
  direccion?: string | null;
  ciudad?: string | null;
  countryCode?: string | null;
}

/**
 * «Servientrega no entra a este sector: el paquete va a la agencia X».
 *
 * Sale de la lista OFICIAL de sectores sin cobertura de Servientrega Ecuador
 * (Drive de Dropi, ago-2026). Medido sobre 11.450 pedidos de la tienda: una
 * dirección en uno de esos sectores entrega 6-7 puntos menos, y Servientrega
 * la manda a la agencia de todas formas — la asesora que lo ve ANTES de
 * despachar le ofrece el retiro al cliente en vez de enterarse por la novedad.
 *
 * Solo Ecuador: la lista es de Servientrega EC. En Colombia no se dibuja nada
 * (no es que «no haya sectores», es que no hay dato). Puro: no consulta nada.
 */
export default memo(function SectorSinCoberturaChip({ direccion, ciudad, countryCode }: Props) {
  if (countryCode !== 'EC') return null;
  const z = sectorSinCobertura(direccion, ciudad);
  if (!z) return null;
  const ag = z.agenciaDetalle;
  const agencia = z.agencia ?? 'más cercana';
  return (
    <span
      className="inline-flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] leading-snug text-warning max-w-full"
      title={`Sector oficial sin cobertura a domicilio de Servientrega: ${z.sector}.${ag ? ` Agencia ${agencia}: ${ag.direccion} (L-V ${ag.horarioLunesViernes}).` : ''}`}
    >
      <Building2 size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <strong>Servientrega no entra a {z.sector}</strong> — lo manda a la agencia {agencia}
        {ag ? ` (${ag.direccion})` : ''}. Ofrecer retiro en agencia antes de despachar.
      </span>
    </span>
  );
});
