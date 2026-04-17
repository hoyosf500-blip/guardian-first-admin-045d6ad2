import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';

type Range = '24h' | '7d' | '30d';

interface Row {
  operator_id: string;
  display_name: string;
  confirmados: number;
  cancelados: number;
  noresp: number;
  novedades_resueltas: number;
  total_atendidos: number;
  tasa_contacto: number;
  tasa_confirmacion: number;
}

const RANGE_LABELS: Record<Range, string> = { '24h': 'Últimas 24h', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días' };

function confColor(v: number): string {
  if (v >= 70) return 'bg-green-500/10 text-green-600 dark:text-green-400';
  if (v >= 65) return 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400';
  return 'bg-destructive/10 text-destructive';
}

export default function ProductivityDashboard() {
  const [range, setRange] = useState<Range>('24h');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    const { data, error } = await supabase.rpc('operator_productivity_stats' as never, { p_range: range } as never);
    if (error) {
      console.error('[productivity] rpc error', error);
    } else {
      setRows((data as Row[]) ?? []);
    }
    setLoading(false);
    setRefreshing(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh on orders changes (debounced 1s) + interval fallback every 60s
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load(true), 1000);
    };

    const channel = supabase
      .channel('admin-productivity')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, debounced)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_results' }, debounced)
      .subscribe();

    const interval = setInterval(() => load(true), 60_000);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const chartData = rows.map(r => ({
    name: r.display_name,
    Confirmados: r.confirmados,
    Cancelados: r.cancelados,
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <TrendingUp size={18} className="text-primary" />
            Productividad por operadora
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">{RANGE_LABELS[range]} · auto-refresh activo</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border bg-card p-0.5">
            {(['24h', '7d', '30d'] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  range === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Tabla detallada</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="animate-spin text-primary" size={20} /></div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Sin actividad en este rango</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Operadora</TableHead>
                    <TableHead className="text-right">Confirmados</TableHead>
                    <TableHead className="text-right">Cancelados</TableHead>
                    <TableHead className="text-right">Nov. resueltas</TableHead>
                    <TableHead className="text-right">Asignados</TableHead>
                    <TableHead className="text-right">Tasa contacto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => (
                    <TableRow key={r.operator_id}>
                      <TableCell className="font-medium">{r.display_name}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/10">
                          {r.confirmados}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant="secondary" className="bg-destructive/10 text-destructive hover:bg-destructive/10">
                          {r.cancelados}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{r.novedades_resueltas}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{r.total_asignados}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.tasa_contacto}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {!loading && rows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Comparativo Confirmados vs Cancelados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: -16, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Confirmados" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Cancelados" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
