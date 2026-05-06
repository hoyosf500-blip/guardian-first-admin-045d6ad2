import { useCallback, useRef, useState } from 'react';
import { FileText, Upload, Loader2, CheckCircle2, AlertCircle, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useParseBankPdf } from '@/hooks/usePersonalCardMovements';
import { toast } from 'sonner';

// Carga pdfjs-dist desde CDN dinámicamente — evita tocar package.json
// (Lovable se queja de cualquier `npm install` extra) y mantiene el bundle
// inicial pequeño. Solo se descarga cuando el usuario decide subir un PDF.
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (params: { data: ArrayBuffer }) => { promise: Promise<PdfDocument> };
}
interface PdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}
interface PdfPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string; transform?: number[] }> }>;
}

let pdfjsModule: PdfJsModule | null = null;
async function loadPdfjs(): Promise<PdfJsModule> {
  if (pdfjsModule) return pdfjsModule;
  // @vite-ignore evita que Vite intente resolver la URL en build time.
  const mod = await import(/* @vite-ignore */ PDFJS_CDN);
  const lib = (mod.default ?? mod) as PdfJsModule;
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
  pdfjsModule = lib;
  return lib;
}

/**
 * Extrae texto plano del PDF preservando saltos de línea por posición Y.
 * El extracto Bancolombia tiene tablas — sin agrupar por línea, los items
 * de una fila quedan dispersos y los regex no matchean nada.
 */
async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;

  const allLines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    // Agrupar items por coordenada Y aproximada (línea visual).
    const lineMap = new Map<number, string[]>();
    for (const item of content.items) {
      const str = item.str ?? '';
      if (!str) continue;
      const y = item.transform ? Math.round(item.transform[5]) : 0;
      // Bucket de 2px para tolerar pequeñas variaciones del renderer
      const bucket = Math.round(y / 2) * 2;
      if (!lineMap.has(bucket)) lineMap.set(bucket, []);
      lineMap.get(bucket)!.push(str);
    }
    // Ordenar de arriba abajo (Y descendente en PDF coords)
    const sortedY = Array.from(lineMap.keys()).sort((a, b) => b - a);
    for (const y of sortedY) {
      const items = lineMap.get(y)!;
      const line = items.join(' ').replace(/\s+/g, ' ').trim();
      if (line) allLines.push(line);
    }
    allLines.push(''); // separador entre páginas
  }
  return allLines.join('\n');
}

interface UploadResult {
  filename: string;
  ok: boolean;
  movements_count?: number;
  inserted?: number;
  updated?: number;
  metadata?: { tarjeta?: string; periodo_corte_from?: string | null; periodo_corte_to?: string | null };
  error?: string;
}

export default function CfoPersonalCardUploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);
  const parsePdf = useParseBankPdf();

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (arr.length === 0) {
      toast.error('Solo se aceptan archivos PDF');
      return;
    }
    setProcessing(true);
    setProgress({ done: 0, total: arr.length });
    const newResults: UploadResult[] = [];

    for (let i = 0; i < arr.length; i++) {
      const file = arr[i];
      try {
        const text = await extractPdfText(file);
        if (text.length < 100) {
          newResults.push({ filename: file.name, ok: false, error: 'PDF vacío o ilegible (¿escaneado?)' });
          setProgress({ done: i + 1, total: arr.length });
          continue;
        }
        const result = await parsePdf.mutateAsync({ text, filename: file.name, dryRun: false });
        newResults.push({
          filename: file.name,
          ok: true,
          movements_count: result.movements_count,
          inserted: result.upsert?.inserted,
          updated: result.upsert?.updated,
          metadata: result.metadata,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        newResults.push({ filename: file.name, ok: false, error: msg });
      }
      setProgress({ done: i + 1, total: arr.length });
    }

    setResults(prev => [...newResults, ...prev]);
    setProcessing(false);
    setProgress(null);

    const okCount = newResults.filter(r => r.ok).length;
    const totalInserted = newResults.reduce((acc, r) => acc + (r.inserted ?? 0), 0);
    if (okCount > 0) {
      toast.success(`${okCount} extracto(s) procesado(s) — ${totalInserted} movimientos nuevos`);
    }
    const errors = newResults.filter(r => !r.ok);
    if (errors.length > 0) {
      toast.error(`${errors.length} extracto(s) fallaron — revisar detalle abajo`);
    }
  }, [parsePdf]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) processFiles(e.dataTransfer.files);
  }, [processFiles]);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <FileText size={18} className="text-accent" />
          <h3 className="font-semibold text-sm">Importar extractos de tarjeta</h3>
        </div>
        <span className="text-xs text-muted-foreground">PDF · Bancolombia</span>
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        className={[
          'rounded-md border-2 border-dashed p-6 text-center transition-colors cursor-pointer',
          isDragging ? 'border-accent bg-accent/5' : 'border-border hover:bg-muted/30',
          processing ? 'opacity-60 pointer-events-none' : '',
        ].join(' ')}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={e => {
            if (e.target.files?.length) processFiles(e.target.files);
            e.currentTarget.value = '';
          }}
        />
        {processing ? (
          <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={20} className="animate-spin text-accent" />
            <span>Procesando {progress?.done ?? 0} de {progress?.total ?? 0}…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
            <Upload size={20} className="text-accent mb-1" />
            <span><span className="text-foreground font-medium">Arrastrá PDFs</span> o hacé clic para elegir</span>
            <span className="text-xs">Acepta varios extractos a la vez. Reimportar el mismo PDF NO duplica datos.</span>
          </div>
        )}
      </div>

      {results.length > 0 && (
        <div className="mt-4 space-y-1 max-h-60 overflow-auto">
          {results.map((r, idx) => (
            <div
              key={`${r.filename}-${idx}`}
              className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded bg-muted/30"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {r.ok ? <CheckCircle2 size={14} className="text-green shrink-0" /> : <AlertCircle size={14} className="text-red shrink-0" />}
                <span className="truncate">{r.filename}</span>
                {r.metadata?.tarjeta && <span className="text-muted-foreground shrink-0">{r.metadata.tarjeta}</span>}
              </div>
              {r.ok ? (
                <span className="text-muted-foreground shrink-0">
                  {r.movements_count} mov · {r.inserted ?? 0} nuevos · {r.updated ?? 0} actualizados
                </span>
              ) : (
                <span className="text-red shrink-0 truncate max-w-[50%]" title={r.error}>{r.error}</span>
              )}
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setResults([])}
            className="text-xs h-6 mt-1"
          >
            Limpiar historial
          </Button>
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <Eye size={12} className="mt-0.5 shrink-0" />
        <span>
          El PDF se procesa <strong>localmente en tu navegador</strong> antes de enviarse.
          No subimos el archivo crudo al servidor — solo el texto categorizado.
        </span>
      </div>
    </div>
  );
}
