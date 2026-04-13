import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface Profile {
  user_id: string;
  display_name: string;
  roles: string[];
}

interface DayReport {
  operator_name: string;
  report_date: string;
  data: Record<string, number>;
}

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
    // Load all profiles with roles
    const { data: profiles } = await supabase.from('profiles').select('user_id, display_name');
    const { data: roles } = await supabase.from('user_roles').select('user_id, role');

    if (profiles && roles) {
      const ops = profiles.map(p => ({
        ...p,
        roles: roles.filter(r => r.user_id === p.user_id).map(r => r.role),
      }));
      setOperators(ops);
    }

    // Load recent daily reports
    const { data: reps } = await supabase.from('daily_reports')
      .select('operator_id, report_date, report_type, data')
      .eq('report_type', 'cierre')
      .order('report_date', { ascending: false })
      .limit(20);

    if (reps && profiles) {
      const mapped = reps.map(r => ({
        operator_name: profiles?.find(p => p.user_id === r.operator_id)?.display_name || 'Desconocido',
        report_date: r.report_date,
        data: r.data as Record<string, number>,
      }));
      setReports(mapped);
    }

    setLoading(false);
  }

  if (!isAdmin) return <div className="text-center py-10 text-muted-foreground">Acceso denegado</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">🔧 Admin</h1>
          <div className="text-xs text-muted-foreground">Panel de administración</div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-lg skeleton-shimmer" />)}
        </div>
      ) : (
        <>
          {/* Operators */}
          <div className="bg-card border border-border rounded-lg p-4 mb-3">
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">👥 Operadoras registradas</h3>
            <div className="space-y-2">
              {operators.map(op => (
                <div key={op.user_id} className="flex items-center justify-between py-2 border-b border-border last:border-b-0">
                  <div>
                    <div className="text-sm font-semibold">{op.display_name}</div>
                    <div className="text-[10px] text-muted-foreground">{op.user_id.slice(0, 8)}...</div>
                  </div>
                  <div className="flex gap-1">
                    {op.roles.map(r => (
                      <span key={r} className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${r === 'admin' ? 'bg-orange/15 text-orange' : 'bg-cyan/15 text-cyan'}`}>
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Reports */}
          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">📊 Cierres recientes</h3>
            {reports.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay cierres aún</p>
            ) : (
              <div className="space-y-2">
                {reports.map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-b-0">
                    <div>
                      <div className="text-sm font-semibold">{r.operator_name}</div>
                      <div className="text-[10px] text-muted-foreground">{r.report_date}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold font-mono text-cyan">
                        {r.data.tasa_confirmacion ?? 0}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        ✅{r.data.confirmados ?? 0} ❌{r.data.cancelados ?? 0} 📵{r.data.no_respondio ?? 0}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
