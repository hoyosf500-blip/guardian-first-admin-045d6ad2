# Seguimiento: "Revisión diaria" — simplificar acciones + forzar gestión diaria

**Fecha:** 2026-05-26 · **Estado:** aprobado, pendiente de implementar

## Problema / objetivo

La card de Seguimiento tiene 7 botones (`Llame cliente`, `WhatsApp enviado`,
`Reclame transportadora`, `Esperando respuesta`, `Resuelto`, `Cliente recogera`,
`Devolucion solicitada`) — demasiados y mezclan *cómo se gestionó* con *el
cierre*. El dueño quiere:
1. **Simplificar** los botones (estilo Confirmación).
2. **Obligar a las operadoras a revisar/gestionar TODOS los pedidos de
   seguimiento cada día** — que el tablero se vacíe diariamente y vuelva a
   llenarse al día siguiente.

## Mecánica actual (la que reusamos)

- Click en acción → `markAction` ([CrmTable.tsx:537](../../../src/components/CrmTable.tsx))
  inserta un `touchpoint` `{phone, action: "SEG: <label>", operator_id,
  action_date, action_time}` y setea un "resultado" local con cooldown
  (`ACTION_SLA_HOURS` en [actionSla.ts](../../../src/lib/actionSla.ts)): el
  pedido se oculta y "vuelve en Xh".
- El cooldown es **estado de sesión** (`results` en CrmTable) → se pierde al
  recargar y no resetea por día.
- `SegCounterBar` ([SegCounterBar.tsx](../../../src/components/SegCounterBar.tsx))
  cuenta touchpoints `SEG:%` del día (acciones / resueltos / tasa).
- Pool compartido: cualquier operadora gestiona cualquier pedido; no hay
  claim/lock en SEG.

## Diseño

### A. Acciones (7 → 1 primario + 2 cierre)

- **Gestioné hoy** (primario): al tocar, despliega chips de método —
  **Llamé · WhatsApp · Reclamé transportadora · Cliente recoge**. Tocar un chip
  registra `touchpoint` `SEG: <método>` y marca el pedido como *gestionado hoy*.
  (2 taps, sin escritura libre.)
- **Resuelto** / **Devolución** (cierre): sale de Seguimiento con snooze largo
  (30 días, como hoy `Resuelto`/`Devolucion solicitada` = 720h).
- Se elimina `Esperando respuesta` como botón: en el modelo diario, todo lo
  no-cerrado reaparece mañana igual.

`SEG_ACTIONS` ([constants.ts:67](../../../src/lib/constants.ts)) y
`ACTION_SLA_HOURS` se simplifican: los métodos de gestión NO llevan cooldown
escalonado (su "vuelve mañana" sale del reset diario, no de un SLA por acción);
solo `Resuelto`/`Devolución` mantienen el snooze largo.

### B. Motor de revisión diaria (lo nuevo)

- **Gestionado hoy** = el pedido tiene un touchpoint `SEG:` con
  `action_date = hoy` (zona Bogotá, vía `bogotaToday()`).
- La lista por defecto muestra **solo los NO gestionados hoy** → se vacía a
  medida que el equipo trabaja (como Confirmación).
- **Reset automático a medianoche Bogotá**: al cambiar `action_date`, los
  activos vuelven a aparecer como pendientes. Sin job ni cron — es derivado.
- Reemplaza el filtro `results` (sesión) por derivación desde `touchpoints`
  (ya cargados en CrmTable) → sobrevive recargas y resetea limpio.
- `Resuelto`/`Devolución` NO reaparecen al día siguiente (snooze 30d).

**Granularidad (decisión v1):** "gestionado hoy" se deriva por **teléfono**
(modelo actual de touchpoints, que no guardan order id). Para repeat-buyers,
gestionar un pedido marca como gestionados los demás del mismo teléfono — OK
porque se atienden en la misma llamada. Si se quiere precisión por pedido,
agregar `order_external_id` al touchpoint (migración chica) — fuera de v1.

### C. Progreso + reporte

- Barra en SeguimientoTab: **"Gestionados hoy: X / Y — faltan Z"** sobre el
  total de pedidos activos de seguimiento (no terminales, dentro del cutoff por
  país). Meta visible: 0 pendientes.
- `SegCounterBar` gana **cobertura del equipo**: `% de seguimiento gestionado
  hoy` — el KPI que el dueño usa para exigir la disciplina diaria.

### D. Pool compartido (sin cambio)

Gestionar un pedido lo marca gestionado-hoy para todo el equipo (desaparece de
la lista de todas). El tablero se limpia en equipo, una vez al día.

## Archivos afectados

- [src/lib/constants.ts](../../../src/lib/constants.ts) — `SEG_ACTIONS`.
- [src/lib/actionSla.ts](../../../src/lib/actionSla.ts) — colapsar a cierre-largo.
- [src/components/CrmTable.tsx](../../../src/components/CrmTable.tsx) — `markAction`
  (registrar método), filtro "gestionado hoy" derivado de touchpoints, sub-menú
  de método en la card de acciones.
- [src/components/tabs/SeguimientoTab.tsx](../../../src/components/tabs/SeguimientoTab.tsx)
  — barra de progreso diaria.
- [src/components/SegCounterBar.tsx](../../../src/components/SegCounterBar.tsx) —
  cobertura del equipo.
- Helper puro nuevo: `src/lib/segDailyReview.ts` (`isGestionadoHoy`,
  conteo de cobertura) + `.test.ts`.

## Verificación

1. Unit: tests del helper puro (`isGestionadoHoy` con touchpoints de hoy/ayer,
   por teléfono; conteo de cobertura). `npm run test` · `lint` · `build`.
2. Manual: marcar "Gestioné hoy → Llamé" → el pedido desaparece de la lista y el
   contador sube. Recargar → sigue gestionado (no reaparece hoy). Simular cambio
   de día → reaparece. `Resuelto` → no vuelve.
3. Pool: gestionar con operadora A → desaparece para operadora B.

## Fuera de alcance (YAGNI)

- Push de `Resuelto`/`Devolución` a Dropi (sigue siendo marca local + snooze).
- Precisión por pedido en touchpoints (queda como upgrade opcional).
- Cambios al modelo de pool / asignación.
