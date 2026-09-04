import { lazy, Suspense } from 'react';

/**
 * `SectorSinCoberturaChip` por `React.lazy`.
 *
 * El chip arrastra el dataset oficial de Ecuador (`dropiEcuador/logisticaOficial`:
 * agencias, sectores sin cobertura, novedades — ~54 KB gzip). Importado de forma
 * estática desde CallView, CrmCallView y NovedadView, ese peso viajaba en la
 * primera carga de Confirmar y Seguimiento aunque la asesora no abriera ningún
 * pedido de Ecuador. Medido en producción el 4-sep-2026 (Fase 2 del rediseño).
 *
 * Misma firma que el chip; `fallback={null}` porque el chip también devuelve
 * `null` mientras no tiene nada que decir — no hay salto de layout.
 */
const Chip = lazy(() => import('./SectorSinCoberturaChip'));

interface Props {
  direccion?: string | null;
  ciudad?: string | null;
  countryCode?: string | null;
}

export default function SectorSinCoberturaChipLazy(props: Props) {
  // Solo Ecuador tiene lista: para las demás tiendas ni se pide el chunk.
  if (props.countryCode !== 'EC') return null;
  return (
    <Suspense fallback={null}>
      <Chip {...props} />
    </Suspense>
  );
}
