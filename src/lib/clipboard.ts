import { toast } from 'sonner';

/**
 * Copia texto al portapapeles con toast de éxito/error. Los navegadores
 * rechazan `navigator.clipboard.writeText` cuando el documento no tiene
 * foco, el permiso fue denegado, o la página está en contexto inseguro
 * — sin `.catch` la operadora cree que copió algo cuando no lo hizo.
 */
export function copyToClipboard(text: string, successMsg: string): Promise<void> {
  return navigator.clipboard.writeText(text).then(
    () => { toast.success(successMsg); },
    () => { toast.error('No se pudo copiar — revisa permisos del navegador'); },
  );
}
