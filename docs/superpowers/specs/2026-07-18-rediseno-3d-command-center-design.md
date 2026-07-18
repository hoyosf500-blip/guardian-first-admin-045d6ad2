# Rediseño visual "3D command center" — Diseño

**Fecha:** 2026-07-18
**Rama:** `redesign/3d-command-center`
**Entrega:** PR único contra `main`, 9 commits (uno por tanda)

## Contexto

El handoff de diseño (`Guardian CRM Rediseño.zip` → `design_handoff_guardian_3d/`) define una
capa visual "command center" oscura para todo el CRM: aurora índigo/violeta, glass, glow,
tilt 3D, cifras en JetBrains Mono con `tabular-nums`.

**El rediseño ya está aplicado a medias.** Estado verificado al 2026-07-18:

| Superficie | Estado real | Líneas |
|---|---|---|
| `pages/AuthPage.tsx` | rediseñado | 408 |
| `tabs/ConfirmarTab.tsx` | rediseñado (referencia) | 920 |
| `ProtectedLayout.tsx` | parcial — aurora + logo, sidebar viejo w-56 / header h-12 | 319 |
| `CallView.tsx` | parcial — glass en 1 card | 1185 |
| `tabs/SeguimientoTab.tsx` | parcial — header + toggle | 832 |
| `tabs/LogisticaTab.tsx` | parcial — header | 824 |
| `pages/OrderDetailPage.tsx` | parcial — glass en 4 cards | 741 |
| `tabs/DashboardTab.tsx` | solo chip de header | 769 |
| `tabs/AdminTab.tsx` | solo chip de header | 391 |
| `tabs/NovedadesTab.tsx` | solo gradiente warning en header | 281 |
| `CrmTable.tsx` | sin tocar | 1447 |
| `CrmCallView.tsx` | sin tocar | 989 |
| `tabs/CfoTab.tsx` | sin tocar | 769 |
| `seguimiento/SegBoard.tsx` | sin tocar | 476 |
| `order-detail/CustomerHistoryCard.tsx` | sin tocar | 703 |
| `components/{admin,cfo,logistics}/*` | sin tocar | ~60 archivos |

Los mensajes de commit previos (`1b1b672`, `2b977b2`) declaran más cobertura de la que
realmente entró. **No usar el git log como fuente de estado.**

Quedan ~7.500 líneas sin tratamiento real.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Alcance | Todas las pantallas + shell + capa de utilidades faltante |
| Movimiento | Completo: tilt 3D, count-up, sheen |
| Entrega | Rama aparte, PR al final, un commit por tanda |
| Rail de navegación | 80px con **ícono + micro-label** en mono 10px (desviación deliberada del mockup, que es solo-ícono) |
| Light mode | Se mantiene coherente por tokens, no se rediseña |

### Por qué el rail lleva micro-label

El mockup pide 80px solo-ícono con tooltip al hover. Las asesoras navegan por la palabra,
no por el ícono, y el tooltip no existe en táctil. El micro-label conserva los 80px y el
look, y elimina la curva de aprendizaje. Es la desviación mínima del handoff.

## Arquitectura

Dos niveles. **Ninguno toca lógica de negocio.**

### Nivel CSS — `src/index.css`

Ya existen (commit `cc71992`): `.bg-aurora`, `.bg-aurora-strong`, `.bg-accent-gradient`,
`.text-accent-gradient`, `.border-gradient-accent`, `.btn-accent-3d`, `.glow-*`,
`.glass-panel`, `.glass-panel-hover`, `.num-glow-*`, `.icon-chip`.

Faltan y se agregan:

- Keyframes: `gb-float`, `gb-spin`, `gb-draw`, `gb-rise`, `gb-pulse`, `gb-sheen`
- `.tilt-3d` — `transition: transform .35s cubic-bezier(.2,.7,.3,1)`, `transform-style: preserve-3d`
- `.hud-label` — mono 10px, `letter-spacing:.2em`, uppercase, `color: --fg-subtle`
- `.corner-bracket` — esquinas cian de la card hero
- `.perspective-floor` — retícula en perspectiva del fondo aurora
- `.sheen` — barrido holográfico

Todo el bloque de movimiento se apaga dentro de `@media (prefers-reduced-motion: reduce)`.

### Nivel React — `src/components/ui3d/` (nuevo)

Solo se crea primitivo lo que aparece 3+ veces en los mockups.

| Primitivo | Origen en el mockup | Consumidores |
|---|---|---|
| `useTilt()` | `.gb-tilt` + `data-tilt` | todas las cards |
| `<TiltCard>` | wrapper `perspective` + capas `translateZ` | todas |
| `<CountUp>` | `data-count` | todo número |
| `<GaugeRing>` | anillo cónico del hero | Dashboard, CFO |
| `<StatTile>` | chip + cifra + label + sparkline | Dashboard, Logística, Novedades, CFO |
| `<Sparkline>` | `polyline` con `stroke-dasharray` | StatTile |
| `<StackedBars>` | "Gestiones por día" | Dashboard |
| `<RankRow>` | fila de ranking con barra | Dashboard, Productividad |
| `<AuroraBackdrop>` | blobs difuminados + retícula | shell, Login |
| `<IconRail>` / `<HudTopbar>` | shell nuevo | ProtectedLayout |

**Contrato de los primitivos:** reciben `number`, `string`, `ReactNode`. Nunca hooks,
queries ni el cliente de Supabase. Esto hace que cualquier cambio de datos en una pantalla
salte a la vista en el diff.

### Restricciones de rendimiento

1. **`backdrop-filter` con techo.** El glass se queda en cards y toolbars (pocas por
   pantalla). **No** va en filas de `CrmTable` ni tarjetas de `SegBoard` — ahí panel sólido
   `rgba(255,255,255,.035)`. 100 filas con blur degradan el scroll en máquinas flojas, y el
   handoff pide explícitamente evitar `backdrop-filter` por internet lento.
2. **Todo lo animado usa solo `transform`/`opacity`** (compositor GPU).
3. **El tilt se apaga solo** en móvil, táctil y `prefers-reduced-motion`. La decisión vive
   en `useTilt`, no se reimplementa por pantalla.

## Tandas

Cada tanda = un commit autocontenido y publicable en `redesign/3d-command-center`.

| # | Tanda | Archivos | Razón del orden |
|---|---|---|---|
| 0 | Capa `ui3d` + CSS | ~12 nuevos | Andamiaje con tests. Nada visible. |
| 1 | Shell: rail 80px + micro-label, topbar HUD 52px, aurora | `ProtectedLayout.tsx` | Enmarca toda la app; máximo efecto por línea tocada. |
| 2 | Dashboard | `DashboardTab.tsx` | Consume casi todos los primitivos: los valida en terreno de bajo riesgo. |
| 3 | Seguimiento | `SeguimientoTab`, `SegBoard`, `CrmTable` | La más grande y de más tráfico; va con primitivos ya probados. |
| 4 | Confirmar (resto) | `CallView`, `CrmCallView` | **La de más riesgo funcional** (ver abajo). |
| 5 | Novedades | `NovedadesTab` | Chica, completa. |
| 6 | Logística | `LogisticaTab` + `components/logistics/*` | Muchos archivos, patrón repetitivo. |
| 7 | Detalle de pedido | `OrderDetailPage` + `order-detail/*` | `CustomerHistoryCard` es el grueso. |
| 8 | Admin + CFO | `AdminTab` + `admin/*`, `CfoTab` + `cfo/*` | Menor tráfico; CFO además está tras triple gate. |
| 9 | Barrido final | — | `bg-card`/`bg-surface` sueltos, contraste AA, móvil 375px, PR. |

### Zonas de riesgo conocidas

- **Tanda 4** es la peligrosa. `CallView`/`CrmCallView` contienen el pipeline de validación
  de dirección (overrides a nivel de módulo `pickupOverrideAppliedIds` /
  `staleGreenOverrideIds`), el `visualDecision` que evita el flash de verde viejo, y el
  `DespachoGateButton`. Se tocan **solo** clases y markup. Si un `visualDecision` o un
  efecto de auto-validación aparece en el diff, es un error y se revierte.
- **`CrmTable`** contiene la lógica de claim/release de la cola de Seguimiento.
- **CFO va al final** porque su triple gate (`VITE_ENABLE_CFO` + `isAdmin` +
  `country_code==='CO'`) lo aísla de las asesoras.

## Verificación por tanda

1. **Diff de solo-presentación.** Revisar el diff buscando lo que no debería estar:
   `useEffect`, `supabase.`, `useState` nuevos, cambios en arrays de dependencias,
   condicionales alterados. Se justifican explícitamente o se revierten.
2. **Cero cambios de texto.** Ni copys ni nombres de métrica. "N/R abiertos" sigue siendo
   "N/R abiertos". Los reportes y el vocabulario del equipo dependen de esas palabras.
3. **`npm run test` y `npm run build` verdes.** Los 55 tests CO y la spec de
   `canConfirmOrder` no deben moverse.
4. **Verificación en vivo** en el puerto 8080: manejar la pantalla de verdad, en tema
   oscuro y claro, y a 375px. Compilar no prueba que el `backdrop-filter` no arruine el
   scroll.

Los primitivos de `ui3d/` llevan tests propios: `CountUp` alcanza el valor final,
`GaugeRing` mapea porcentaje a grados, `useTilt` no hace nada en táctil.

## Fuera de alcance

- Arreglar bugs encontrados de paso (se reportan, quedan para después)
- Renombrar, mover lógica o refactorizar
- Diseñar un light mode nuevo
- Redeploy de edge functions o migraciones (este trabajo no toca ni una)
