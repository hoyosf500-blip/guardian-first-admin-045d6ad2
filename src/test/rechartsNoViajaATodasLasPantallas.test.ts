import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: recharts (chunk `vendor-charts`, ~109 KB gzip) no viaja a pantallas
 * que no dibujan gráficos.
 *
 * ── Qué pasó (medido en producción, 4-sep-2026) ─────────────────────────────
 * `src/components/ui3d/index.ts` reexportaba `StackedDayBars`, el único
 * componente del barril que importa recharts. Ese barril lo importan ~40
 * archivos, ProtectedLayout incluido, así que TODAS las páginas —hasta
 * /auth— bajaban los gráficos sin dibujar ninguno. Con la reexportación, el
 * tree-shaking no puede soltar recharts (tiene efectos secundarios al cargar).
 *
 * Lo mismo con el dataset de cobertura de Ecuador (~54 KB gzip): entraba a la
 * primera pantalla porque `SectorSinCoberturaChip` se importaba de forma
 * estática desde CallView/CrmCallView/NovedadView. Va por `React.lazy`.
 */
const raiz = join(__dirname, '..', '..');
const leer = (p: string) => readFileSync(join(raiz, p), 'utf8');

describe('recharts no viaja a todas las pantallas', () => {
  it('el barril ui3d NO reexporta StackedDayBars (el único con recharts)', () => {
    const barril = leer('src/components/ui3d/index.ts');
    expect(barril).not.toMatch(/export\s*\{\s*default\s+as\s+StackedDayBars\s*\}/);
    // El tipo sí puede viajar: `export type` no arrastra código.
  });

  it('ningún archivo del barril ui3d, salvo StackedDayBars, importa recharts', () => {
    const archivos = ['TiltCard', 'CountUp', 'GaugeRing', 'Sparkline', 'StatTile', 'RankRow', 'AuroraBackdrop', 'IconRail', 'HudTopbar', 'useTilt', 'useCountUp'];
    for (const a of archivos) {
      let src = '';
      try { src = leer(`src/components/ui3d/${a}.tsx`); } catch { src = leer(`src/components/ui3d/${a}.ts`); }
      expect(src, `${a} importa recharts`).not.toMatch(/from\s+['"]recharts['"]/);
    }
  });

  it('clsx está nombrado en un chunk propio: si no, Rollup lo mete en vendor-charts y el entry lo importa entero', () => {
    // Medido en producción (4-sep-2026): `import{c as Sc}from"./vendor-charts-…"`
    // en el chunk de entrada — 418 KB de gráficos para un símbolo de 500 bytes.
    const vite = leer('vite.config.ts');
    const vendorUi = vite.match(/'vendor-ui':\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(vendorUi).toMatch(/'clsx'/);
    expect(vendorUi).toMatch(/'tailwind-merge'/);
  });

  it('ProtectedLayout y sus contextos no importan recharts ni el dataset de cobertura', () => {
    for (const p of ['src/components/ProtectedLayout.tsx', 'src/contexts/OrderContext.tsx', 'src/contexts/StoreContext.tsx', 'src/App.tsx']) {
      const src = leer(p);
      expect(src, `${p} importa recharts`).not.toMatch(/from\s+['"]recharts['"]/);
      expect(src, `${p} importa el dataset de cobertura`).not.toMatch(/dropiEcuador\/logisticaOficial/);
    }
  });

  it('el chip de cobertura entra por React.lazy en las pantallas de trabajo', () => {
    for (const p of ['src/components/CallView.tsx', 'src/components/CrmCallView.tsx', 'src/components/NovedadView.tsx']) {
      const src = leer(p);
      expect(src, `${p} importa el chip de forma estática`).not.toMatch(/from\s+['"]@\/components\/SectorSinCoberturaChip['"]/);
      expect(src).toMatch(/SectorSinCoberturaChipLazy/);
    }
    expect(leer('src/components/SectorSinCoberturaChipLazy.tsx')).toMatch(/lazy\(\(\)\s*=>\s*import\(/);
  });
});
