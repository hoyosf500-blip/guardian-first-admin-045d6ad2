import { useRef } from 'react';
import { Upload } from 'lucide-react';

interface Props {
  onFile: (file: File) => void;
}

export default function ExcelUploader({ onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  };

  return (
    <div className="mb-4">
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className="group relative border-2 border-dashed border-border rounded-2xl p-10 text-center cursor-pointer transition-all hover:border-primary/40 hover:bg-primary/[0.02]"
      >
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center mx-auto mb-3 group-hover:scale-105 transition-transform">
          <Upload size={22} className="text-primary" />
        </div>
        <p className="font-semibold text-sm text-foreground">Sube el Excel de Dropi</p>
        <p className="text-[11px] text-muted-foreground mt-1">Arrastra o haz clic para seleccionar · .xlsx, .xls, .csv</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={e => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    </div>
  );
}
