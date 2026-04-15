import { useState, useCallback, useEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { parseExcelToOrders, formatDateES, OrderData } from '@/lib/orderUtils';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import ExcelUploader from '@/components/ExcelUploader';
import AperturaWizard from '@/components/AperturaWizard';
import WorkList from '@/components/WorkList';
import CallView from '@/components/CallView';
import WorkFilters from '@/components/WorkFilters';
import { AlertTriangle, List, Phone, RefreshCw, CloudDownload } from 'lucide-react';

function dbToOrderData(o: any, idx: number): OrderData {
  return {
    idx, id: String(idx), externalId: o.external_id || '', dbId: o.id,
    nombre: o.nombre, phone: o.phone, ciudad: o.ciudad || '',
    producto: o.producto || '', estado: o.estado || '', fecha: o.fecha || '',
    fechaConf: o.fecha_conf || '', dias: o.dias || 0, diasConf: o.dias_conf || 0,
    valor: Number(o.valor) || 0, flete: Number(o.flete) || 0,
    costoProd: Number(o.costo_prod) || 0, costoDev: Number(o.costo_dev) || 0,
    cantidad: o.cantidad || 1, direccion: o.direccion || '',
    novedad: o.novedad || '', guia: o.guia || '',
    transportadora: o.transportadora || '', tags: o.tags || '',
    departamento: o.departamento || '', tienda: o.tienda || '',
    novedadSol: o.novedad_sol || false,
  };
}

interface Props {
  profile: { display_name: string } | null;
  onLogout: () => void;
}

export default function ConfirmarTab({ profile }: Props) {
  const { user } = useAuth();
  const { workQueue, allOrders, setAllOrders, buildWorkQueue, counter, resetOrders, excelLoaded, setExcelLoaded } = useOrders();
  const [view, setView] = useState<'list' | 'call'>('list');
  const [filter, setFilter] = useState('pending');
  const [search, setSearch] = useState('');
  const [aperturaCompleted, setAperturaCompleted] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [showExcel, setShowExcel] = useState(false);
  const today = new Date().toISOString().split('T')[0];

  // Auto-load orders from DB on mount if not already loaded
  useEffect(() => {
    if (excelLoaded || !user || autoLoading) return;
    setAutoLoading(true);
    supabase.from('orders').select('*').ilike('estado', '%PENDIENTE%')
      .then(({ data: dbOrders }) => {
        if (dbOrders && dbOrders.length > 0) {
          const orders = dbOrders.map((o, idx) => dbToOrderData(o, idx));
          setAllOrders(orders);
          buildWorkQueue(orders);
          setExcelLoaded(true);
        }
        setAutoLoading(false);
      });
  }, [user, excelLoaded, today]);

  const handleFile = useCallback(async (file: File) => {
    toast.info('Procesando Excel...');
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
        toast.success(`${orders.length} pedidos cargados`);
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
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-muted-foreground">{formatDateES(today)}</p>
        {excelLoaded && (
          <button onClick={() => { resetOrders(); setExcelLoaded(false); }}
            className="text-xs px-3 py-1.5 rounded-lg bg-secondary text-muted-foreground font-medium hover:bg-secondary/80 transition-colors">
            Cambiar archivo
          </button>
        )}
      </div>

      {autoLoading && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <RefreshCw size={32} className="text-primary animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando pedidos...</p>
            <p className="text-xs text-muted-foreground mt-1">Recuperando datos de la base de datos</p>
          </div>
        </div>
      )}

      {!autoLoading && !excelLoaded && !aperturaCompleted && (
        <AperturaWizard onComplete={() => setAperturaCompleted(true)} />
      )}

      {!autoLoading && !excelLoaded && (
        <div className="space-y-3">
          {/* Dropi Sync Button */}
          <button
            onClick={async () => {
              if (!user) return;
              setSyncing(true);
              try {
                const { data, error } = await supabase.functions.invoke('dropi-sync', {
                  body: {},
                });
                if (error) throw error;
                if (data?.synced > 0 || data?.total > 0) {
                  // Reload orders from DB
                  const { data: dbOrders } = await supabase.from('orders')
                    .select('*')
                    .ilike('estado', '%PENDIENTE%');
                  if (dbOrders && dbOrders.length > 0) {
                    const orders = dbOrders.map((o, idx) => dbToOrderData(o, idx));
                    setAllOrders(orders);
                    buildWorkQueue(orders);
                    setExcelLoaded(true);
                    toast.success(`${dbOrders.length} pedidos cargados desde Dropi`);
                  }
                } else {
                  toast.info(data?.message || 'No hay pedidos nuevos en Dropi');
                }
              } catch (err: any) {
                toast.error('Error sincronizando: ' + (err.message || 'Error desconocido'));
              } finally {
                setSyncing(false);
              }
            }}
            disabled={syncing}
            className="w-full flex items-center justify-center gap-3 py-4 px-5 rounded-xl bg-card border border-border hover:border-blue/30 hover:bg-blue/5 transition-all group"
          >
            <div className="w-10 h-10 rounded-xl bg-blue/10 flex items-center justify-center group-hover:bg-blue/20 transition-colors">
              {syncing ? <RefreshCw size={20} className="text-blue animate-spin" /> : <CloudDownload size={20} className="text-blue" />}
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold text-foreground">
                {syncing ? 'Sincronizando...' : 'Sincronizar desde Dropi'}
              </div>
              <div className="text-[10px] text-muted-foreground">Descarga automáticamente los pedidos del día</div>
            </div>
          </button>

          <button
            onClick={() => setShowExcel(!showExcel)}
            className="w-full flex items-center justify-center gap-2 py-2 text-[10px] text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
          >
            <div className="flex-1 h-px bg-border" />
            <span>{showExcel ? 'Ocultar' : 'O sube manualmente'}</span>
            <div className="flex-1 h-px bg-border" />
          </button>

          {showExcel && <ExcelUploader onFile={handleFile} />}
        </div>
      )}

      {excelLoaded && (
        <>
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

          {(() => {
            const d7 = workQueue.filter(o => o.dias >= 7 && !o.result).length;
            const d46 = workQueue.filter(o => o.dias >= 4 && o.dias <= 6 && !o.result).length;
            if (!d7 && !d46) return null;
            return (
              <div className="flex gap-2 mb-4 flex-wrap">
                {d7 > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red/10 text-red border border-red/15">
                    <span className="w-2 h-2 rounded-full bg-red" /> {d7} cancelar (D7+)
                  </span>
                )}
                {d46 > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow/10 text-yellow border border-yellow/15">
                    <span className="w-2 h-2 rounded-full bg-yellow" /> {d46} urgente (D4-6)
                  </span>
                )}
              </div>
            );
          })()}

          <div className="bg-card rounded-xl border border-border p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <WorkFilters workQueue={workQueue} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} />
            </div>
            <div className="flex gap-2">
              {([
                { key: 'list' as const, icon: List, label: 'Lista' },
                { key: 'call' as const, icon: Phone, label: 'Llamada' },
              ]).map(v => (
                <button key={v.key} onClick={() => setView(v.key)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                    view === v.key ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                  }`}>
                  <v.icon size={14} /> {v.label}
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
