import { useState, useMemo } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import DateRangeFilter from '@/components/logistics/DateRangeFilter';
import CompactKpiGrid from '@/components/logistics/CompactKpiGrid';
import LogisticsHeroChart from '@/components/logistics/LogisticsHeroChart';
import GeoDistribution from '@/components/logistics/GeoDistribution';
import CarrierStatsTable from '@/components/logistics/CarrierStatsTable';
import CityReturnsTable from '@/components/logistics/CityReturnsTable';
import ProductFailuresTable from '@/components/logistics/ProductFailuresTable';
import LogisticsSkeleton from '@/components/logistics/LogisticsSkeleton';
import LogisticsErrorState from '@/components/logistics/LogisticsErrorState';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { Truck, MapPin, Package, RefreshCw } from 'lucide-react';

function defaultRange(): LogisticsFilters {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return {
    fromDate: from.toISOString().split('T')[0],
    toDate: to.toISOString().split('T')[0],
  };
}

function formatRange(filters: LogisticsFilters): string {
  const f = new Date(filters.fromDate);
  const t = new Date(filters.toDate);
  const fmt = (d: Date) => d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  return `${fmt(f)} → ${fmt(t)}`;
}

export default function LogisticaTab() {
  const [filters, setFilters] = useState<LogisticsFilters>(defaultRange);

  const { summary, carriers, cities, products, isLoading, isError } = useLogisticsStats(filters);

  const errorMsg = useMemo(() => {
    if (summary.isError)  return summary.error?.message;
    if (carriers.isError) return carriers.error?.message;
    if (cities.isError)   return cities.error?.message;
    if (products.isError) return products.error?.message;
    return undefined;
  }, [summary, carriers, cities, products]);

  const refetchAll = () => {
    summary.refetch(); carriers.refetch(); cities.refetch(); products.refetch();
  };

  // dataUpdatedAt expone el timestamp del último fetch exitoso en
  // TanStack Query — sirve para que el admin sepa qué tan fresca
  // es la métrica que está leyendo.
  const lastUpdated = summary.dataUpdatedAt
    ? new Date(summary.dataUpdatedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="space-y-6">
      {/* Page header — patrón dashboard profesional. Eyebrow
          uppercase tracking-wide, título tight, range pill +
          refresh con timestamp en una sola línea derecha. */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
            Análisis · Admin
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none">
            Logística
          </h1>
          <p className="text-sm text-muted-foreground">
            Rendimiento por transportadora, devoluciones por ciudad y productos con peor entrega.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!isLoading && !isError && summary.data && (
            <span className="pill pill-neutral whitespace-nowrap">
              {formatRange(filters)}
            </span>
          )}
          {lastUpdated && (
            <span className="text-[11px] text-muted-foreground tabular-nums hidden md:inline">
              Actualizado {lastUpdated}
            </span>
          )}
          <button
            type="button"
            onClick={refetchAll}
            disabled={isLoading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:border-border-strong hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Refrescar datos"
            title="Refrescar"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Filtros — date range. Border suave para no competir con
          los datos. */}
      <div className="rounded-lg border border-border bg-card p-3">
        <DateRangeFilter value={filters} onChange={setFilters} />
      </div>

      {/* Estados globales */}
      {isError && <LogisticsErrorState message={errorMsg} onRetry={refetchAll} />}

      {!isError && isLoading && <LogisticsSkeleton />}

      {!isError && !isLoading && (
        <>
          {/* HERO ROW — chart de volumen (col-span-7) + KPIs 2×2 (col-span-5).
              En mobile colapsan a stacked. Patrón referencia: dashboard
              logístico profesional (chart dominante + KPIs side panel). */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7">
              <LogisticsHeroChart rows={carriers.data ?? []} />
            </div>
            <div className="lg:col-span-5">
              <CompactKpiGrid data={summary.data ?? null} />
            </div>
          </div>

          {/* DETAIL ROW — tabs con detalle (col-span-7) + geo distribution
              lateral (col-span-5). Mobile: stacked. */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7">
              <Tabs defaultValue="carriers" className="w-full">
                <TabsList>
                  <TabsTrigger value="carriers"><Truck size={13} className="mr-1.5" /> Transportadoras</TabsTrigger>
                  <TabsTrigger value="cities"><MapPin size={13} className="mr-1.5" /> Ciudades</TabsTrigger>
                  <TabsTrigger value="products"><Package size={13} className="mr-1.5" /> Productos</TabsTrigger>
                </TabsList>

                <TabsContent value="carriers" className="mt-4">
                  <CarrierStatsTable rows={carriers.data ?? []} />
                </TabsContent>
                <TabsContent value="cities" className="mt-4">
                  <CityReturnsTable rows={cities.data ?? []} />
                </TabsContent>
                <TabsContent value="products" className="mt-4">
                  <ProductFailuresTable rows={products.data ?? []} />
                </TabsContent>
              </Tabs>
            </div>
            <div className="lg:col-span-5">
              <GeoDistribution rows={cities.data ?? []} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
