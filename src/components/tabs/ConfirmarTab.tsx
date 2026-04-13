import { useState, useCallback } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { parseExcelToOrders, formatDateES } from '@/lib/orderUtils';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import ExcelUploader from '@/components/ExcelUploader';
import AperturaWizard from '@/components/AperturaWizard';
import WorkList from '@/components/WorkList';
import CallView from '@/components/CallView';
import WorkFilters from '@/components/WorkFilters';

interface Props {
  profile: { display_name: string } | null;
  onLogout: () => void;
}

export default function ConfirmarTab({ profile }: Props) {
  const { user } = useAuth();
  const { workQueue, allOrders, setAllOrders, buildWorkQueue, counter, resetOrders } = useOrders();
  const [view, setView] = useState<'list' | 'call'>('list');
  const [filter, setFilter] = useState('pending');
  const [search, setSearch] = useState('');
  const [aperturaCompleted, setAperturaCompleted] = useState(false);
  const [excelLoaded, setExcelLoaded] = useState(false);

  const today = new Date().toISOString().split('T')[0];

  const handleFile = useCallback(async (file: File) => {
    toast.info('⏳ Procesando Excel...');
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, unknown>[];
        if (!raw.length) { toast.error('Excel vacío'); return; }
        const orders = parseExcelToOrders(raw);
        if (!orders.length) { toast.error('No se encontraron columnas de nombre/teléfono'); return; }
        if (user) {
          const dbOrders = orders.map(o => ({
            external_id: o.externalId, uploaded_by: user.id, upload_date: today,
            nombre: o.nombre, phone: o.phone, ciudad: o.ciudad, producto: o.producto,
            estado: o.estado, fecha: o.fecha, fecha_conf: o.fechaConf, dias: o.dias,
            dias_conf: o.diasConf, valor: o.valor, flete: o.flete, costo_prod: o.costoProd,
            costo_dev: o.costoDev, cantidad: o.cantidad, direccion: o.direccion,
            novedad: o.novedad, guia: o.guia, transportadora: o.transportadora,
            tags: o.tags, departamento: o.departamento, tienda: o.tienda, novedad_sol: o.novedadSol,
          }));
          const { data, error } = await supabase.from('orders').insert(dbOrders).select('id, phone');
          if (error) { toast.error('Error guardando pedidos'); return; }
          const phoneIdMap = new Map(data?.map(d => [d.phone, d.id]) ?? []);
          orders.forEach(o => { o.dbId = phoneIdMap.get(o.phone); });
        }
        setAllOrders(orders);
        buildWorkQueue(orders);
        setExcelLoaded(true);
        toast.success(`✅ ${orders.length} pedidos cargados`);
      } catch (err: any) { toast.error('Error leyendo Excel: ' + err.message); }
    };
    reader.readAsArrayBuffer(file);
  }, [user, today, setAllOrders, buildWorkQueue]);

  const filteredItems = workQueue.filter(o => {
    if (filter === 'pending' && o.result) return false;
    if (filter === 'conf' && o.result !== 'conf') return false;
    if (filter === 'canc' && o.result !== 'canc') return false;
    if (filter === 'noresp' && o.result !== 'noresp') return false;
    if (filter.startsWith('prod_') && (o.producto !== filter.slice(5) || o.result)) return false;
    if (search) {
      const s = search.toLowerCase();
      return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) || o.ciudad.toLowerCase().includes(s);
    }
    return true;
  });

  const total = counter.conf + counter.canc + counter.noresp;
  const pending = workQueue.filter(o => !o.result).length;

  return (
    <div className="max-w-5xl mx-auto">
      {/* Summary bar */}
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-muted-foreground">{formatDateES(today)}</p>
        {excelLoaded && (
          <button onClick={() => { resetOrders(); setExcelLoaded(false); }}
            className="text-xs px-3 py-1.5 rounded-lg bg-secondary text-muted-foreground font-medium hover:bg-secondary/80 transition-colors">
            Cambiar archivo
          </button>
        )}
      </div>

      {!excelLoaded && !aperturaCompleted && (
        <AperturaWizard onComplete={() => setAperturaCompleted(true)} />
      )}

      {!excelLoaded && <ExcelUploader onFile={handleFile} />}

      {excelLoaded && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Por confirmar', value: pending, color: 'text-blue' },
              { label: 'Confirmados', value: counter.conf, color: 'text-green' },
              { label: 'Cancelados', value: counter.canc, color: 'text-red' },
              { label: 'Gestionados', value: total, color: 'text-foreground' },
            ].map(kpi => (
              <div key={kpi.label} className="bg-card rounded-xl border border-border p-4">
                <div className="text-xs text-muted-foreground font-medium mb-1">{kpi.label}</div>
                <div className={`font-mono text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
              </div>
            ))}
          </div>

          {/* Priority badges */}
          {(() => {
            const d6 = workQueue.filter(o => o.dias >= 6 && !o.result).length;
            const d5 = workQueue.filter(o => o.dias === 5 && !o.result).length;
            const d34 = workQueue.filter(o => o.dias >= 3 && o.dias <= 4 && !o.result).length;
            if (!d6 && !d5 && !d34) return null;
            return (
              <div className="flex gap-2 mb-4 flex-wrap">
                {d6 > 0 && <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red/10 text-red border border-red/15">🔴 {d6} cancelar (D6+)</span>}
                {d5 > 0 && <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-orange/10 text-orange border border-orange/15">🟠 {d5} último (D5)</span>}
                {d34 > 0 && <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue/10 text-blue border border-blue/15">🔵 {d34} urgente (D3-4)</span>}
              </div>
            );
          })()}

          {/* Controls */}
          <div className="bg-card rounded-xl border border-border p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <WorkFilters workQueue={workQueue} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} />
            </div>
            <div className="flex gap-2">
              {(['list', 'call'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                    view === v ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                  }`}>
                  {v === 'list' ? '📋 Lista' : '📞 Llamada'}
                </button>
              ))}
            </div>
          </div>

          {view === 'list' ? (
            <WorkList items={filteredItems} onOpenCall={() => setView('call')} />
          ) : (
            <CallView items={filteredItems} />
          )}
        </>
      )}
    </div>
  );
}
