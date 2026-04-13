import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface Profile { user_id: string; display_name: string; roles: string[]; }
interface DayReport { operator_name: string; report_date: string; data: Record<string, number>; }

export default function AdminTab() {
  const { isAdmin } = useAuth();
  const [operators, setOperators] = useState<Profile[]>([]);
  const [reports, setReports] = useState<DayReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAdmin) return;
    loadData();
  }, [isAdmin]);

  async function loadData() {
    setLoading(true);
    const { data: profiles } = await supabase.from('profiles').select('user_id, display_name');
    const { data: roles } = await supabase.from('user_roles').select('user_id, role');
    if (profiles && roles) {
      setOperators(profiles.map(p => ({ ...p, roles: roles.filter(r => r.user_id === p.user_id).map(r => r.role) })));
    }
    const { data: reps } = await supabase.from('daily_reports')
      .select('operator_id, report_date, report_type, data')
      .eq('report_type', 'cierre').order('report_date', { ascending: false }).limit(20);
    if (reps && profiles) {
      setReports(reps.map(r => ({
        operator_name: profiles?.find(p => p.user_id === r.operator_id)?.display_name || 'Desconocido',
        report_date: r.report_date, data: r.data as Record<string, number>,
      })));
    }
    setLoading(false);
  }

  if (!isAdmin) return <div className="text-center py-10 text-muted-foreground">Acceso denegado</div>;

  return (
    <div className="max-w-5xl mx-auto">
      <p className="text-sm text-muted-foreground mb-5">Panel de administración</p>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-xl skeleton-shimmer" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Operators */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">Operadoras registradas</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{operators.length} usuarios</p>
            </div>
            <div className="divide-y divide-border">
              {operators.map(op => (
                <div key={op.user_id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-bold text-foreground">
                      {op.display_name[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-foreground">{op.display_name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{op.user_id.slice(0, 8)}…</div>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {op.roles.map(r => (
                      <span key={r} className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        r === 'admin' ? 'bg-orange/10 text-orange' : 'bg-blue/10 text-blue'
                      }`}>{r}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Reports */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">Cierres recientes</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{reports.length} reportes</p>
            </div>
            {reports.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No hay cierres aún</div>
            ) : (
              <div className="divide-y divide-border">
                {reports.map((r, i) => (
                  <div key={i} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <div className="text-sm font-medium text-foreground">{r.operator_name}</div>
                      <div className="text-xs text-muted-foreground">{r.report_date}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold font-mono text-foreground">{r.data.tasa_confirmacion ?? 0}%</div>
                      <div className="text-[10px] text-muted-foreground">
                        ✅{r.data.confirmados ?? 0} ❌{r.data.cancelados ?? 0} 📵{r.data.no_respondio ?? 0}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
