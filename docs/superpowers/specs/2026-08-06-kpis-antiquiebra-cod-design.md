# KPIs anti-quiebra para COD — diseño

**Fecha:** 2026-08-06
**Origen:** balance de Colombia ene–mar 2026, medido contra la billetera de Dropi y los
reportes de Meta. No es un ejercicio teórico: reconstruye una pérdida real de entre
**$16,5M y $21,9M COP en tres meses** que ningún tablero mostró mientras ocurría.

---

## 1. Qué pasó, en datos

Dos cuentas de Dropi. La vieja hasta febrero; la actual desde marzo.

| | ene–feb 2026 | marzo 2026 |
|---|---:|---:|
| Pedidos generados | 701 | 477 |
| Pedidos entregados | 347 | 252 |
| Vendido (panel Dropi) | $48.959.719 | $43.382.636 |
| **Entró de verdad a la billetera** | **+$16.147.122** | **+$7.307.176** |
| — de eso, comisión de referidos | $4.770.000 | $0 |
| Pauta Facebook | −$22.213.337 | −$13.873.490 |
| Costos fijos (≈$3,08M/mes) | −$6.160.000 | −$3.080.000 |
| **Resultado** | **−$12.226.215** | **−$9.646.314** |

Fuentes: export "historial de cartera" de Dropi (5.164 y 232 movimientos), panel de Dropi,
e informe de Meta Ads (`business_id=103894218445762`, 15 cuentas publicitarias).

### El hallazgo central

**La tasa de entrega necesaria para no perder era superior al 100%.**

```
tasa_equilibrio = (pauta + costos_fijos) / (generados × margen_bruto_por_entrega)

ene–feb: (22.213.337 + 6.160.000) / (701 × 35.106) = 115%
marzo:   (13.873.490 + 3.080.000) / (477 × 28.997) = 122%
```

Aunque hubiera entregado el 100% de los pedidos, perdía. **El problema no era operativo.**
Todo el esfuerzo del CRM —confirmar mejor, bajar devoluciones, perseguir novedades— no podía
mover un negocio cuyo CPA superaba al margen desde el primer peso.

### Por qué no se veía

Meta reportaba un negocio que no existía:

| | Meta decía | real |
|---|---:|---:|
| ROAS ene–feb | 3,84x | **1,37x** |
| ROAS marzo | 4,52x | **2,20x** |
| Costo por compra ene–feb | $30.429 | **$64.015 por ENTREGA** |
| Costo por compra marzo | $26.127 | **$55.053 por ENTREGA** |

Dos capas apiladas: Meta reportó **74% más ingresos** de los que Dropi registró, y contó la
venta al hacer clic — pero en COD solo ~62–70% de los pedidos resueltos se entregan y cobran.
Con 4,52x en pantalla, escalar era la decisión obvia. Con 2,20x real, cada peso extra de
pauta profundizaba el hueco.

### De dónde salió la plata

De la billetera de Dropi salieron $9,9M en ene–feb (retiros $4,38M + recargas a la tarjeta
virtual $5,52M) contra $22,2M de pauta. **Los $12,3M restantes los puso la tarjeta de
crédito.** Ahí nace la deuda.

### Verificación hecha antes de afirmar nada

El informe de Meta agrega 15 cuentas publicitarias de un BM ajeno, así que había que descartar
que parte del gasto fuera de otro. **Meta contó 730 compras (ene–feb) y 531 (marzo); Dropi
registró 701 y 477 pedidos generados** — calce de 96% y 89%. Si esas cuentas hubieran estado
vendiendo otra cosa, las compras de Meta superarían de lejos a los pedidos de Dropi. El gasto
era del negocio.

---

## 2. Los KPI que faltan en Guardian

Guardian hoy mide la operación con precisión (entregas, devoluciones, novedades, ganancia neta
de la billetera) pero **no cruza nunca la operación contra lo que costó traer esos pedidos**.
`store_ad_spend_daily` existe desde el PR #113 y para Colombia tiene **cero registros**. Sin
pauta cargada, "Neto Real" es un número inflado que no puede dar una mala noticia.

Cada KPI abajo se define por lo que habría gritado en enero de 2026.

### KPI 1 — CPA por ENTREGA (no por compra)

```
cpa_entrega = pauta_del_periodo / pedidos_ENTREGADOS_del_periodo
```

Meta cobra por compra; en COD la compra no es plata. Se paga por el pedido que **llegó**.
Mostrar los dos lado a lado, siempre: `$26.127 (Meta) → $55.053 (real)`.

**Fuentes:** `store_ad_spend_daily` + `orders` (estado entregado). Ambas ya existen.

### KPI 2 — Margen de contribución por entrega ⚠️ EL PRINCIPAL

```
margen_unitario = (ganancia_neta_dropi / entregados) − cpa_entrega
```

- ene–feb: $35.106 − $64.015 = **−$28.909**
- marzo: $28.997 − $55.053 = **−$26.056**

**Si es negativo, cada venta adicional hunde más.** Es el único KPI que responde "¿escalo o
paro?". Debe ser la tarjeta principal de `/cfo` y de `/logistica → Finanzas`, por encima de
cualquier total acumulado — un acumulado positivo puede convivir con un unitario negativo
durante meses.

### KPI 3 — Tasa de entrega de equilibrio

```
tasa_equilibrio = (pauta + costos_fijos) / (generados × margen_bruto_por_entrega)
```

Se compara contra la tasa madura real. **Si el equilibrio supera el 100%, ninguna mejora
operativa salva el mes** y hay que decirlo con esas palabras. Es el KPI que convierte una
pérdida difusa en una frase accionable: *"no es la operación, es el CPA"*.

### KPI 4 — Factor de inflado de la plataforma

```
inflado = valor_conversion_Meta / ingreso_cobrado_real
```

ene–feb 2,80x · marzo 2,05x. Se muestra junto al ROAS de Meta para que nadie decida con el
número de la plataforma. Por encima de 1,5x, el ROAS de Meta deja de ser utilizable.

### KPI 5 — Origen del financiamiento de la pauta

```
% financiado con deuda = (pauta − retiros − recargas_tarjeta) / pauta
```

ene–feb: 55% de la pauta salió de la tarjeta de crédito, no del negocio. **Ese es el
indicador de quiebra inminente**, y es independiente de si el mes "dio ganancia":
un negocio que paga su publicidad con crédito está consumiendo patrimonio aunque el P&L
contable se vea neutro.

**Fuentes:** categorías `retiro` de `dropi_wallet_movements` + las recargas de tarjeta (hoy
caen en `otro` — ver KPI 7) + pauta cargada.

### KPI 6 — Conciliación plataforma ↔ Dropi

```
desvío = compras_Meta / pedidos_generados_Dropi − 1
```

ene–feb +4%, marzo +11%. Un desvío creciente significa atribución inflada o fuga de pedidos
que nunca llegaron a Dropi (el mismo problema que ya ataca `shopify-reconcile`, pero un
escalón más arriba).

### KPI 7 — Separación gasto personal / gasto del negocio

Al principio los gastos personales y los del negocio iban mezclados; hoy están parcialmente
separados. Mientras estén mezclados **ningún KPI de arriba es confiable**, porque el
denominador incluye plata que no es del negocio (y al revés).

Piezas que ya existen y hay que conectar: el módulo de tarjeta personal del CFO
(`CfoPersonalCardUploader` + `parse-bank-pdf-text`), `monthly_business_inputs` y
`tc_debt_snapshots`. Falta la marca explícita **personal / negocio** por movimiento y que los
KPI 1–6 excluyan lo personal.

**Además:** `mapCategoria` en `dropi-wallet-sync` no reconoce
`SALIDA POR RECARGA DE TARJETA DE CREDITO` (36 movimientos, $5.521.200 en ene–feb caen en
`otro`). Es justamente el movimiento que financia la pauta. Necesita su categoría
`recarga_tarjeta` — tesorería, no gasto operativo — para que el KPI 5 sea calculable.

---

## 3. Reglas de presentación (no negociables)

Estos KPI existen para dar malas noticias a tiempo. Si se pueden ver en verde estando mal,
no sirven — es exactamente la lección del badge de la billetera, que marcó verde durante
semanas mientras el cron llevaba un mes fallando.

1. **Sin pauta cargada, no se muestra "Neto Real" ni ninguna utilidad neta.** Se muestra el
   hueco: *"falta el gasto de pauta de marzo — este número está inflado"*. Un cero silencioso
   por dato faltante es la forma más cara de mentir, y ya pasó con
   `useLogisticaMonthlyCosts`.
2. **El margen unitario negativo manda sobre cualquier acumulado positivo.** Rojo, arriba,
   sin depender de que alguien abra una pestaña.
3. **Nunca mostrar el ROAS de la plataforma solo.** Siempre pareado con el real y el factor
   de inflado.
4. **Los KPI se calculan por COHORTE** (fecha del pedido), no por fecha de pago. La memoria
   `logistica_date_attribution` ya documenta por qué: por fecha de pago la caja se ve
   inflada y no reconcilia.

## 4. Fuera de alcance por ahora

- Atribución pedido↔anuncio (eso es lo que hace Wintrack; ver `wintrack_competencia`).
- Carga automática de la pauta vía API de Meta. Arrancar con carga manual mensual —
  `monthly_ad_spend` y `store_ad_spend_daily` ya existen y no se usan.
- Ecuador. Los KPI son country-agnostic por construcción, pero la medición de este documento
  es de Colombia.

## 5. Lo que falta medir

Pauta de **abril a julio de 2026** (cuentas propias). Con eso se cierra el balance completo
y se ve en qué mes —si es que ocurrió— el margen unitario se dio vuelta.
