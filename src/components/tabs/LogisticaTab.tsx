import { useState, useMemo } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import DateRangeFilter from '@/components/logistics/DateRangeFilter';
import MinOrdersFilter from '@/components/logistics/MinOrdersFilter';
import SummaryCards from '@/components/logistics/SummaryCards';
import CarrierStatsTable from '@/components/logistics/CarrierStatsTable';
import CityReturnsTable from '@/components/logistics/CityReturnsTable';
import ProductFailuresTable from '@/components/logistics/ProductFailuresTable';
import LogisticsSkeleton from '@/components/logistics/LogisticsSkeleton';
import LogisticsErrorState from '@/components/logistics/LogisticsErrorState';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { Truck, MapPin, Package } from 'lucide-react';

function defaultRange(): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return {
    fromDate: from.toISOString().split('T')[0],
    toDate: to.toISOString().split('T')[0],
  };
}

export default function LogisticaTab() {
  const [filters, setFilters] = useState<LogisticsFilters>(() => ({
    ...defaultRange(),
    minOrders: 5,
  }));

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

  return (
    <div className="space-y-5">
      {/* Filtros */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between border border-border bg-card rounded-xl p-3.5">
        <DateRangeFilter
          value={{ fromDate: filters.fromDate, toDate: filters.toDate }}
          onChange={r => setFilters(f => ({ ...f, ...r }))}
        />
        <MinOrdersFilter
          value={filters.minOrders}
          onChange={n => setFilters(f => ({ ...f, minOrders: n }))}
        />
      </div>

      {/* Estados globales */}
      {isError && <LogisticsErrorState message={errorMsg} onRetry={refetchAll} />}

      {!isError && isLoading && <LogisticsSkeleton />}

      {!isError && !isLoading && (
        <>
          {/* KPIs */}
          <SummaryCards data={summary.data ?? null} />

          {/* Sub-tabs */}
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
        </>
      )}
    </div>
  );
}
