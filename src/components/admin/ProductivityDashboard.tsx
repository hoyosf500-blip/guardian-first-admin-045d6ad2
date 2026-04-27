import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, TrendingUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';

type Range = 'today' | '24h' | '7d' | '30d';

interface Row {
  operator_id: string;
  display_name: string;
  confirmados: number;
  cancelados: number;
  noresp: number;
  novedades_resueltas: number;
  seg_acciones: number;
  seg_resueltos: number;
  rescate_acciones: number;
  rescate_resueltos: number;
  total_atendidos: number;
  tasa_contacto: number;
  tasa_confirmacion: number;
}

const RANGE_LABELS: Record<Range, string> = {
  'today': 'Hoy',
  '24h': 'Últimas 24h',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
};

function confColor(v: number): string {
  if (v >= 70) return 'bg-green-500/10 text-green-600 dark:text-green-400';
  if (v >= 65) return 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400';
  return 'bg-destructive/10 text-destructive';
}

export default function ProductivityDashboard() {
  const [range, setRange] = useState<Range>('today');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Antes solo console.error → la UI mostraba "Sin actividad" indistinguible
  // de un error silenciado vs cero filas reales. Ahora capturamos el mensaje
  // y lo renderizamos como banner visible para diagnóstico inmediato.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    const { data, error: rpcErr } = await supabase.rpc('operator_productivity_stats' as never, { p_range: range } as never);
    if (rpcErr) {
      console.error('[productivity] rpc error', rpcErr);
      const e = rpcErr as { code?: string; message?: string; hint?: string; details?: string };
      setError(`${e.code || 'ERR'}: ${e.message || 'Error desconocido'}${e.hint ? ` — ${e.hint}` : ''}${e.details ? ` (${e.details})` : ''}`);
      setRows([]);
    } else {
      const arr = (data as Row[] | null) ?? [];
      console.log('[productivity] rows received', arr.length);
      setRows(arr);
      setError(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh con realtime (debounced 1s). El polling de 60s previo
  // era redundante — realtime ya dispara en cualquier cambio de orders
  // o INSERT en order_results. Suscribimos también a touchpoints para
  // refrescar cuando alguien marca acción en SEG/RESCUE.
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
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'touchpoints' }, debounced)
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
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
            {(['today', '24h', '7d', '30d'] as Range[]).map(r => (
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

      {error && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="py-3">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 mb-1">
              Error cargando productividad
            </p>
            <p className="text-xs text-foreground/80 font-mono break-all">{error}</p>
            <p className="text-[10px] text-muted-foreground mt-2">
              Si dice <code>function ... does not exist</code>: la migration de la RPC
              no se aplicó. Si dice <code>42501</code> o <code>Solo administradores</code>:
              tu usuario no tiene rol admin en <code>user_roles</code>. Cualquier otro
              error: copialo y mandámelo.
            </p>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Card>
          <CardContent className="flex justify-center py-10">
            <Loader2 className="animate-spin text-primary" size={20} />
          </CardContent>
        </Card>
      ) : !error && rows.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground text-center py-8">Sin actividad en este rango</p>
          </CardContent>
        </Card>
      ) : !error ? (
        <>
          {/* Confirmar — métricas del flujo de confirmación de pedidos */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true" />
                Confirmar
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operadora</TableHead>
                      <TableHead className="text-right">Confirmados</TableHead>
                      <TableHead className="text-right">Cancelados</TableHead>
                      <TableHead className="text-right">No resp.</TableHead>
                      <TableHead className="text-right">Atendidos</TableHead>
                      <TableHead className="text-right">Tasa contacto</TableHead>
                      <TableHead className="text-right">Tasa confirmación</TableHead>
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
                        <TableCell className="text-right text-muted-foreground">{r.noresp}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{r.total_atendidos}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{r.tasa_contacto}%</TableCell>
                        <TableCell className="text-right">
                          <Badge variant="secondary" className={`${confColor(r.tasa_confirmacion)} hover:${confColor(r.tasa_confirmacion)} font-mono text-xs`}>
                            {r.tasa_confirmacion}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Seguimiento — touchpoints SEG: agrupados por operadora */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500" aria-hidden="true" />
                Seguimiento
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operadora</TableHead>
                      <TableHead className="text-right">Acciones</TableHead>
                      <TableHead className="text-right">Resueltos</TableHead>
                      <TableHead className="text-right">Pendientes</TableHead>
                      <TableHead className="text-right">Tasa de resolución</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(r => {
                      const pendientes = Math.max(0, r.seg_acciones - r.seg_resueltos);
                      const tasa = r.seg_acciones > 0
                        ? Math.round((r.seg_resueltos / r.seg_acciones) * 100)
                        : 0;
                      return (
                        <TableRow key={r.operator_id}>
                          <TableCell className="font-medium">{r.display_name}</TableCell>
                          <TableCell className="text-right">
                            <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10">
                              {r.seg_acciones}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10">
                              {r.seg_resueltos}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">{pendientes}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{tasa}%</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Rescate — touchpoints RESCUE: agrupados por operadora */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500" aria-hidden="true" />
                Rescate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operadora</TableHead>
                      <TableHead className="text-right">Acciones</TableHead>
                      <TableHead className="text-right">Resueltos</TableHead>
                      <TableHead className="text-right">Pendientes</TableHead>
                      <TableHead className="text-right">Tasa de resolución</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(r => {
                      const pendientes = Math.max(0, r.rescate_acciones - r.rescate_resueltos);
                      const tasa = r.rescate_acciones > 0
                        ? Math.round((r.rescate_resueltos / r.rescate_acciones) * 100)
                        : 0;
                      return (
                        <TableRow key={r.operator_id}>
                          <TableCell className="font-medium">{r.display_name}</TableCell>
                          <TableCell className="text-right">
                            <Badge variant="secondary" className="bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/10">
                              {r.rescate_acciones}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10">
                              {r.rescate_resueltos}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">{pendientes}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{tasa}%</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Novedades — solo si hay alguna en el rango */}
          {rows.some(r => r.novedades_resueltas > 0) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
                  Novedades
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Operadora</TableHead>
                        <TableHead className="text-right">Resueltas</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.filter(r => r.novedades_resueltas > 0).map(r => (
                        <TableRow key={r.operator_id}>
                          <TableCell className="font-medium">{r.display_name}</TableCell>
                          <TableCell className="text-right">
                            <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10">
                              {r.novedades_resueltas}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}

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
