# Progreso — Guardian First Admin

Archivo de memoria entre sesiones. Se actualiza al terminar cada sesión o bloque significativo de trabajo.

---

## Completado

- Añadidas reglas de calidad y sistema de memoria a `CLAUDE.md` (2026-04-17)

## En progreso

- (nada activo)

## Pendiente

- **B-distribution:** reparto de órdenes tipo B entre operadores
- **Address-edit-sync:** sincronización de direcciones editadas con Dropi
- Limpieza de card UI residual "Credenciales Dropi (flujo Bearer)" en `src/components/tabs/AdminTab.tsx`
- Limpieza de keys residuales en `app_settings` del flujo Bearer (`dropi_email`, `dropi_password`, `dropi_white_brand_id`, `dropi_token`, `dropi_token_at`, `dropi_token_ttl_min`, `dropi_env`)

## Decisiones tomadas

- **Dropi auth:** usar `dropi-integration-key`, NO Bearer (la cuenta tiene 2FA que bloquea el flujo Bearer del PDF oficial)
- **white_brand_id:** requerido en llamadas a Dropi (RUSHMIRA = 1)
- **Edge Functions y migraciones SQL:** NO se deployan automáticamente al pushear a `main` — hay que pedirle a Lovable AI por chat
- **Trigger `protect_confirmed_orders`:** no remover; evita que `dropi-sync` pise confirmaciones locales del día
- **Tests:** no mockear la base de datos, usar Supabase real
