export { default as TiltCard } from './TiltCard';
export { default as CountUp } from './CountUp';
export { default as GaugeRing, pctToDegrees } from './GaugeRing';
export { default as Sparkline, buildPolylinePoints } from './Sparkline';
export { default as StatTile } from './StatTile';
export type { StatTone } from './StatTile';
export { default as RankRow } from './RankRow';
// ⛔ StackedDayBars NO se reexporta desde acá (Fase 2 del rediseño, 4-sep-2026).
// Es el único componente de ui3d que importa recharts, y este barril lo importan
// 40 archivos —ProtectedLayout incluido—, así que el chunk `vendor-charts`
// (109 KB gzip) viajaba a TODAS las pantallas, hasta al login. Medido en
// producción: /seguimiento bajaba los gráficos sin dibujar ninguno. Quien lo
// necesite lo importa directo desde './StackedDayBars' (hoy solo DashboardTab).
export type { DayBar } from './StackedDayBars';
export { default as AuroraBackdrop } from './AuroraBackdrop';
export { default as IconRail } from './IconRail';
export type { RailItem } from './IconRail';
export { default as HudTopbar } from './HudTopbar';
export { useTilt, rotationFromPointer } from './useTilt';
export { useCountUp, easeOutCubic, valueAtProgress } from './useCountUp';
