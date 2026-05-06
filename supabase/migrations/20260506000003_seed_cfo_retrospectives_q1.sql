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
      'CPP CLON 7 todavía arrastra el promedio (ROAS bajo) pero no se cortó'
    ]::TEXT[],
    ARRAY[
      'CPP CLON 12 empezó a despegar — primera señal de creatividad ganadora',
      'Bajamos Andres Pitalito de $1.85M a $182k (-90%) cuando vimos que no rendía'
    ]::TEXT[],
    'El patrón de aprendizaje empezó a funcionar (cortar lo malo rápido), pero la decisión grande — pasar la pauta a un método de pago no diferido — no se tomó. Lección: la calidad de la decisión sobre EN QUÉ pautar no compensa el daño de CÓMO pagás esa pauta.',
    '[
      {"accion":"Pausar campañas con ROAS < 1.8 al cierre de cada semana","deadline":null,"status":"pendiente"}
    ]'::JSONB,
    NULL
  ),
  (
    '2026-04',
    ARRAY[
      'Mantuvimos pauta Meta en USD aunque ya teníamos opciones — la deuda siguió creciendo',
      'Andres Pitalito ROAS 3.10x al límite — debió pausarse antes',
      'Tasa de devolución sigue alta en ciudades específicas (Quibdó, Tumaco, Buenaventura tipo)'
    ]::TEXT[],
    ARRAY[
      'CPP CLON 12 ROAS 6.60x — top performer Meta del trimestre',
      'CPP CLON 7 ROAS 4.68x — mejoró respecto a feb/mar, ya rinde',
      'Entrada de TikTok ($8.77M, 4 cuentas) pagada con Amex COP → NO se difirió',
      'INSTITUTO SAN JUDAS TADEO TikTok CPA $14.9k — mejor cuenta del canal'
    ]::TEXT[],
    'Abril fue el primer mes donde el FB ya rendía bien (ROAS 4-6x) pero la deuda igual subió porque seguíamos pagando con la TC equivocada. Aprendizaje grande: TikTok pagado con Amex pesos NO genera deuda residual. Si en feb hubiéramos arrancado así, la foto sería distinta.',
    '[
      {"accion":"Medir ROAS por (cuenta × producto) cada lunes","deadline":null,"status":"pendiente"},
      {"accion":"Bloquear envíos a top 5 ciudades con devolución >50%","deadline":null,"status":"pendiente"}
    ]'::JSONB,
    NULL
  )
ON CONFLICT (year_month) DO NOTHING;
