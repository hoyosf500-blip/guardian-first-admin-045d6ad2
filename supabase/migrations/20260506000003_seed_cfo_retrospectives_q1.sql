-- Seeds iniciales de la bitácora CFO para Q1 2026 + abril.
--
-- Sembrado conservador: solo lo que ya conocemos del análisis hecho con
-- Fabian (auto-deferral FB USD, dominancia CPP CLON 7, despegue de
-- CPP CLON 12 en marzo, entrada de TikTok en abril). El usuario puede
-- editar/borrar/agregar items en /cfo → Bitácora mensual.
--
-- Idempotente: ON CONFLICT preserva lo que el usuario haya editado a mano.
-- Si quiere resembrar desde cero, primero borra esas filas en la tabla.

INSERT INTO public.cfo_monthly_retrospective
  (year_month, fugas, aciertos, lecciones, decisiones, notas)
VALUES
  (
    '2026-01',
    ARRAY[
      'Mes de arranque sin volumen — gasto pauta no convirtió todavía',
      'Sin sistema de validación de direcciones aún (devoluciones evitables)'
    ]::TEXT[],
    ARRAY[
      'Curva de aprendizaje: probamos producto/anuncio sin quemar mucha plata',
      'Pauta contenida ($701k Meta) — no pisamos el acelerador a ciegas'
    ]::TEXT[],
    'Enero fue mes de validación. Lo correcto: no escalar antes de tener una creatividad ganadora. La duda fue si seguir o cortar.',
    '[
      {"accion":"Definir métrica de corte: si en feb no llegamos a 10 ord/día, pausar","deadline":null,"status":"pendiente"}
    ]'::JSONB,
    NULL
  ),
  (
    '2026-02',
    ARRAY[
      'Pauta saltó a $16.9M de golpe pagada en Mastercard USD → auto-diferida a 36 cuotas al 25.5% EA',
      'CPP CLON 7 fue el 75% del gasto y todavía no convertía (sin retorno)',
      'Pago pauta vía TC USD = la deuda crece sin que se vea en wallet (no es cash flow visible)',
      'Avances en efectivo COP usados para cubrir pauta — la peor decisión financiera del trimestre'
    ]::TEXT[],
    ARRAY[]::TEXT[],
    'Acá fue donde se fabricó la deuda. La pauta pagada en USD tiene 2 problemas: (1) cada $1M se vuelve $1.19M en 18 meses por intereses, (2) no aparece en el cash flow del wallet hasta que se factura la TC el mes siguiente — es invisible mientras se quema. Si en feb hubiéramos pagado pauta con Amex pesos o desde wallet, hoy no estaríamos en $35M.',
    '[
      {"accion":"Migrar 100% pauta Meta de cuenta USD a cuenta COP","deadline":null,"status":"pendiente"},
      {"accion":"Prohibir avances en efectivo (regla dura, no negociable)","deadline":null,"status":"pendiente"}
    ]'::JSONB,
    NULL
  ),
  (
    '2026-03',
    ARRAY[
      'Pauta sigue en USD → la deuda residual crece +$13.8M más este mes',
      'CPP CLON 7 todavía arrastra el promedio (ROAS bajo) pero no se cortó',
      'Avance sucursal virtual $750.000 el 10-mar a 24 cuotas (saldo pendiente $718.750) — comisión avance $6.840 + 25.5% EA',
      'Compras personales por $3.012.707 en el corte 15-feb/15-mar (SAZOMA La Sazon 17 cargos, BOLD*, HYM Jardín Plaza $225k, Yire Sport $634k a 2 cuotas) — gasto personal alto sobre TC del negocio'
    ]::TEXT[],
    ARRAY[
      'CPP CLON 12 empezó a despegar — primera señal de creatividad ganadora',
      'Bajamos Andres Pitalito de $1.85M a $182k (-90%) cuando vimos que no rendía',
      '31-mar: solicité ampliación de plazo Bancolombia para consolidar saldo USD disperso (USD 4.305,82 capital + USD 51,86 ajustes intereses/comisión) → cuota fija USD 179,41/mes a 24 meses al 25.5% EA'
    ]::TEXT[],
    'El patrón de aprendizaje en pauta empezó a funcionar (cortar lo malo rápido), pero la decisión grande — pasar la pauta a un método de pago no diferido — no se tomó. La ampliación de plazo USD a 24 cuotas NO es un ahorro: refinancia el saldo a la misma tasa (25.5% EA), solo da claridad de cuota fija. La verdadera salida es PAGAR antes del próximo corte para evitar intereses acumulados. Lección: la calidad de la decisión sobre EN QUÉ pautar no compensa el daño de CÓMO pagás esa pauta — y la ampliación de plazo solo consolida la deuda, no la cura.',
    '[
      {"accion":"Pausar campañas con ROAS < 1.8 al cierre de cada semana","deadline":null,"status":"pendiente"},
      {"accion":"Pagar capital de la ampliación USD por encima de la cuota mínima cada mes que haya cash","deadline":null,"status":"pendiente"},
      {"accion":"NO MÁS avances en efectivo — regla dura","deadline":null,"status":"pendiente"}
    ]'::JSONB,
    'Movimientos de la ampliación de plazo en TC *9999 confirmados por carta Bancolombia req 8018518461 (5-may-2026): 31/03/2026 Abono ampliación USD 4.357,68 + 31/03/2026 Ampliación USD 4.305,82 a 24 cuotas (cuota USD 179,41 a 1.9110% mensual = 25.5026% EA) + 06/04/2026 ajuste intereses/comisión USD 51,86 a 3 cuotas (cuota USD 17,29 a 0%).'
  ),
  (
    '2026-04',
    ARRAY[
      'Mantuvimos pauta Meta en USD aunque ya teníamos opciones — la deuda siguió creciendo',
      'Andres Pitalito ROAS 3.10x al límite — debió pausarse antes',
      'Tasa de devolución sigue alta en ciudades específicas (Quibdó, Tumaco, Buenaventura tipo)',
      'Bancolombia aplicó ampliación de plazo en pesos sin que yo la autorizara (descubierto al revisar carta del 23-abr) — alerta sobre confiar en gestiones bancarias telefónicas sin confirmación escrita'
    ]::TEXT[],
    ARRAY[
      'CPP CLON 12 ROAS 6.60x — top performer Meta del trimestre',
      'CPP CLON 7 ROAS 4.68x — mejoró respecto a feb/mar, ya rinde',
      'Entrada de TikTok ($8.77M, 4 cuentas) pagada con Amex COP → NO se difirió',
      'INSTITUTO SAN JUDAS TADEO TikTok CPA $14.9k — mejor cuenta del canal',
      'Pago $1.597.521 el 18-abr canceló 100% deuda pesos del corte 15-abr en TC *9999 — confirmado por Bancolombia',
      'Reclamo escalado req 8018518461: Bancolombia reconoció error de ampliación pesos no autorizada → devuelven $36.101,43 de intereses cobrados de más'
    ]::TEXT[],
    'Abril fue el primer mes donde el FB ya rendía bien (ROAS 4-6x) pero la deuda igual subió porque seguíamos pagando con la TC equivocada. Aprendizaje grande: TikTok pagado con Amex pesos NO genera deuda residual. Si en feb hubiéramos arrancado así, la foto sería distinta. Lección extra del mes: revisar SIEMPRE la carta/escrito de cualquier gestión bancaria — la ampliación pesos no autorizada se detectó solo porque escalé el reclamo y validaron la grabación de la llamada.',
    '[
      {"accion":"Medir ROAS por (cuenta × producto) cada lunes","deadline":null,"status":"pendiente"},
      {"accion":"Bloquear envíos a top 5 ciudades con devolución >50%","deadline":null,"status":"pendiente"},
      {"accion":"Pedir SIEMPRE confirmación por escrito antes de aceptar cualquier ampliación/refinanciación bancaria","deadline":null,"status":"pendiente"},
      {"accion":"Confirmar abono de $36.101,43 reflejado en TC *9999 (próximos 2 días hábiles desde 5-may)","deadline":"2026-05-08","status":"pendiente"}
    ]'::JSONB,
    'Documentación: carta Bancolombia req 8018518461 (5-may-2026) + extracto TC *9999 corte 15-feb/15-mar 2026 (PESOS deuda $3.772.414, USD deuda $2.009). Pago alternativa cancelado: $1.597.521 el 18-abr.'
  )
ON CONFLICT (year_month) DO NOTHING;
