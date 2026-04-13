import { useState, useCallback, useRef } from 'react';
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

interface Props {
  profile: { display_name: string } | null;
  onLogout: () => void;
}

export default function ConfirmarTab({ profile, onLogout }: Props) {
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

        // Save orders to DB
        if (user) {
          const dbOrders = orders.map(o => ({
            external_id: o.externalId,
            uploaded_by: user.id,
            upload_date: today,
            nombre: o.nombre,
            phone: o.phone,
            ciudad: o.ciudad,
            producto: o.producto,
            estado: o.estado,
            fecha: o.fecha,
            fecha_conf: o.fechaConf,
            dias: o.dias,
            dias_conf: o.diasConf,
            valor: o.valor,
            flete: o.flete,
            costo_prod: o.costoProd,
            costo_dev: o.costoDev,
            cantidad: o.cantidad,
            direccion: o.direccion,
            novedad: o.novedad,
            guia: o.guia,
            transportadora: o.transportadora,
            tags: o.tags,
            departamento: o.departamento,
            tienda: o.tienda,
            novedad_sol: o.novedadSol,
          }));

          const { data, error } = await supabase.from('orders').insert(dbOrders).select('id, phone');
          if (error) { toast.error('Error guardando pedidos'); console.error(error); return; }

          // Map DB IDs back to orders
          const phoneIdMap = new Map(data?.map(d => [d.phone, d.id]) ?? []);
          orders.forEach(o => { o.dbId = phoneIdMap.get(o.phone); });
        }

        setAllOrders(orders);
        buildWorkQueue(orders);
        setExcelLoaded(true);
        toast.success(`✅ ${orders.length} pedidos cargados`);
      } catch (err: any) {
        toast.error('Error leyendo Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [user, today, setAllOrders, buildWorkQueue]);

  const filteredItems = workQueue.filter(o => {
    // Filter by status
    if (filter === 'pending' && o.result) return false;
    if (filter === 'conf' && o.result !== 'conf') return false;
    if (filter === 'canc' && o.result !== 'canc') return false;
    if (filter === 'noresp' && o.result !== 'noresp') return false;
    if (filter.startsWith('prod_') && (o.producto !== filter.slice(5) || o.result)) return false;

    // Search
    if (search) {
      const s = search.toLowerCase();
      return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) || o.ciudad.toLowerCase().includes(s);
    }
    return true;
  });

  const hasCounter = workQueue.length > 0;

  return (
    <div className={hasCounter ? 'pt-14' : ''}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">📞 Confirmar</h1>
          <div className="text-xs text-muted-foreground">{formatDateES(today)}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green" />
          <span className="text-sm font-semibold">{profile?.display_name || ''}</span>
          <button onClick={onLogout} className="text-[10px] px-2 py-1 rounded-md bg-muted text-muted-foreground font-semibold">
            Salir
          </button>
        </div>
      </div>

      {/* Apertura */}
      {!excelLoaded && !aperturaCompleted && (
        <AperturaWizard onComplete={() => setAperturaCompleted(true)} />
      )}

      {/* Excel Upload */}
      {!excelLoaded && (
        <ExcelUploader onFile={handleFile} />
      )}

      {/* Work Section */}
      {excelLoaded && (
        <>
          {/* Summary KPIs */}
          <div className="flex justify-between items-center mb-3">
            <span className="text-sm font-bold text-muted-foreground">
              📊 {allOrders.length} pedidos · {workQueue.length} por confirmar
            </span>
            <button onClick={() => { resetOrders(); setExcelLoaded(false); }} className="text-xs px-3 py-1.5 rounded-md bg-muted text-muted-foreground font-semibold">
              📁 Cambiar
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5 mb-3">
            <div className="bg-card border border-border rounded-lg p-3.5 text-center border-l-[3px] border-l-cyan">
              <div className="font-mono text-3xl font-bold text-cyan">{workQueue.filter(o => !o.result).length}</div>
              <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wide mt-1">Por confirmar</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3.5 text-center border-l-[3px] border-l-green">
              <div className="font-mono text-3xl font-bold text-green">{counter.conf + counter.canc + counter.noresp}</div>
              <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wide mt-1">Gestionados</div>
            </div>
          </div>

          {/* Priority badges */}
          {(() => {
            const d6 = workQueue.filter(o => o.dias >= 6 && !o.result).length;
            const d5 = workQueue.filter(o => o.dias === 5 && !o.result).length;
            const d34 = workQueue.filter(o => o.dias >= 3 && o.dias <= 4 && !o.result).length;
            if (!d6 && !d5 && !d34) return null;
            return (
              <div className="flex gap-1 mb-2 flex-wrap">
                {d6 > 0 && <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-red/10 text-red">🔴 {d6} cancelar (D6+)</span>}
                {d5 > 0 && <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-orange/10 text-orange">🟠 {d5} último (D5)</span>}
                {d34 > 0 && <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue/10 text-blue">🔵 {d34} urgente (D3-4)</span>}
              </div>
            );
          })()}

          <WorkFilters
            workQueue={workQueue}
            filter={filter}
            setFilter={setFilter}
            search={search}
            setSearch={setSearch}
          />

          <div className="flex gap-1.5 mb-3">
            <button
              onClick={() => setView('list')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${view === 'list' ? 'bg-cyan/10 text-cyan border-cyan/30' : 'bg-muted/50 text-muted-foreground border-border'}`}
            >📋 Lista</button>
            <button
              onClick={() => setView('call')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${view === 'call' ? 'bg-cyan/10 text-cyan border-cyan/30' : 'bg-muted/50 text-muted-foreground border-border'}`}
            >📞 Llamada</button>
          </div>

          {view === 'list' ? (
            <WorkList items={filteredItems} onOpenCall={(idx) => { setView('call'); }} />
          ) : (
            <CallView items={filteredItems} />
          )}
        </>
      )}
    </div>
  );
}
