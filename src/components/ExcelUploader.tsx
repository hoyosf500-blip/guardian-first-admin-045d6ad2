import { useRef } from 'react';

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
        className="border-[1.5px] border-dashed border-cyan/30 rounded-lg p-10 text-center cursor-pointer transition-all bg-cyan/[0.03] hover:bg-cyan/[0.08] active:bg-cyan/[0.08]"
      >
        <div className="text-4xl mb-2">📁</div>
        <p className="font-semibold text-sm">Sube el Excel de Dropi</p>
        <p className="text-[11px] text-muted-foreground mt-1">El mismo archivo que compartieron por WhatsApp</p>
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
