import { createContext, useContext, type ReactNode } from 'react';

// ── Bot de WhatsApp RETIRADO (2026-08-13) ───────────────────────────────────
// El bot no se usaba ni se iba a usar, así que se quitó el subsistema entero:
// edge functions wa-*, librerías _shared/wa*, el inbox de Seguimiento, los
// paneles de /admin y (por SQL del dueño) las tablas wa_* / product_knowledge.
//
// Este archivo queda a propósito como STUB no-op: conserva la MISMA firma
// pública (`useWaChat` / `WaChatProvider`) para NO tener que editar las 6
// pantallas que lo consumían —CallView, CrmCallView, CrmTable, NovedadView,
// SegBoard, OrderDetailPage—, varias marcadas como frágiles. Todos sus botones
// de WhatsApp ya iban gateados por `waEnabled`; con `waEnabled=false` no se
// renderizan y `openChat` es un no-op. Si algún día vuelve el bot, se
// reimplementa acá sin tocar a los consumidores.

export type OpenChatMode = 'thread' | 'none';

interface OpenChatArgs {
  phone: string | null | undefined;
  name?: string | null;
}

interface WaChatContextValue {
  openChat: (args: OpenChatArgs) => Promise<OpenChatMode>;
  waEnabled: boolean;
}

const NOOP: WaChatContextValue = {
  openChat: async () => 'none',
  waEnabled: false,
};

const WaChatContext = createContext<WaChatContextValue>(NOOP);

export function useWaChat(): WaChatContextValue {
  return useContext(WaChatContext);
}

export function WaChatProvider({ children }: { children: ReactNode }) {
  return <WaChatContext.Provider value={NOOP}>{children}</WaChatContext.Provider>;
}
