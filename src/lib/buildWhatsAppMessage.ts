// src/lib/buildWhatsAppMessage.ts
interface BuildInput {
  missing_fields: string[];
  nombre: string;
  producto?: string;
}

const FIELD_LABELS: Record<string, string> = {
  placa: 'el número de la placa de la casa o apartamento',
  barrio: 'el barrio',
  complemento: 'algún punto de referencia (cerca a un colegio, tienda, etc.)',
  telefono: 'un número de teléfono alternativo',
};

export function buildWhatsAppMessage(input: BuildInput): string {
  if (input.missing_fields.length === 0) return '';

  const saludo = input.nombre ? `Hola ${input.nombre}` : 'Hola';
  const productoCtx = input.producto ? `Para tu pedido de "${input.producto}", ` : 'Para tu pedido, ';

  const labels = input.missing_fields.map((f) => FIELD_LABELS[f]).filter(Boolean);

  if (labels.length === 0) {
    return `${saludo}, ${productoCtx}necesito que me confirmes algunos datos de tu dirección para poder despacharlo. ¿Puedes ayudarme?`;
  }

  const lista = labels.length === 1
    ? labels[0]
    : labels.slice(0, -1).join(', ') + ' y ' + labels[labels.length - 1];

  return `${saludo}, ${productoCtx}me hace falta confirmar ${lista}. ¿Me lo puedes pasar por aquí para despacharte cuanto antes?`;
}
