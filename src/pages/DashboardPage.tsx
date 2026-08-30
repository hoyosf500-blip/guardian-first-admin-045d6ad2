import DashboardTab from '@/components/tabs/DashboardTab';
import { useStore } from '@/contexts/StoreContext';

/**
 * ⛔ `key={activeStoreId}` — REMONTA la pantalla al cambiar de tienda.
 *
 * DashboardTab guarda en estado local los pedidos, el histórico de gestiones y
 * el ranking de operadoras. Al cambiar de Colombia a Ecuador el encabezado ya
 * decía Ecuador mientras "Total pedidos", la torta de productos, el detalle por
 * producto, el desglose por estado y el ranking seguían siendo los de Colombia,
 * sin ningún indicador de que ese dato era de otra empresa. Mezclar países en
 * pantalla está PROHIBIDO en esta operación, aunque dure unos segundos.
 *
 * Se hace acá y no limpiando estado dentro de cada efecto a propósito: es a
 * prueba de olvidos. El próximo `useState` que alguien agregue adentro queda
 * cubierto sin que tenga que acordarse de resetearlo.
 */
export default function DashboardPage() {
  const { activeStoreId } = useStore();
  return <DashboardTab key={activeStoreId ?? 'sin-tienda'} />;
}
