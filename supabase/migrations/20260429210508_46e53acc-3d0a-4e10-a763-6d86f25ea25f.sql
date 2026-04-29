-- COST-3b: retención más agresiva + audit_log más liviano

-- 1. Reducir retención a 7 días (más que suficiente para investigar)
CREATE OR REPLACE FUNCTION public.cleanup_old_logs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audit_deleted integer;
  v_sync_deleted integer;
BEGIN
  DELETE FROM public.audit_log WHERE created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS v_audit_deleted = ROW_COUNT;

  DELETE FROM public.sync_logs WHERE created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS v_sync_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'audit_deleted', v_audit_deleted,
    'sync_deleted',  v_sync_deleted,
    'ran_at', NOW()
  );
END;
$$;

-- 2. Trigger de auditoría liviano: solo guarda diff, no rows enteras
-- Antes: INSERT con to_jsonb(OLD) + to_jsonb(NEW) = ~3 KB por update
-- Ahora: solo los campos que cambiaron = ~200 B por update (15x más liviano)
CREATE OR REPLACE FUNCTION public.audit_order_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  changed text[] := ARRAY[]::text[];
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.audit_log (table_name, operation, row_id, old_data, user_id)
    VALUES ('orders', 'DELETE', OLD.id::text,
            jsonb_build_object('estado', OLD.estado, 'phone', OLD.phone, 'external_id', OLD.external_id),
            auth.uid());
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Solo trackear cambios en campos relevantes y guardar SOLO el delta
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
      changed := array_append(changed, 'estado');
      v_old := v_old || jsonb_build_object('estado', OLD.estado);
      v_new := v_new || jsonb_build_object('estado', NEW.estado);
    END IF;
    IF NEW.valor IS DISTINCT FROM OLD.valor THEN
      changed := array_append(changed, 'valor');
      v_old := v_old || jsonb_build_object('valor', OLD.valor);
      v_new := v_new || jsonb_build_object('valor', NEW.valor);
    END IF;
    IF NEW.flete IS DISTINCT FROM OLD.flete THEN
      changed := array_append(changed, 'flete');
      v_old := v_old || jsonb_build_object('flete', OLD.flete);
      v_new := v_new || jsonb_build_object('flete', NEW.flete);
    END IF;
    IF NEW.costo_prod IS DISTINCT FROM OLD.costo_prod THEN
      changed := array_append(changed, 'costo_prod');
      v_old := v_old || jsonb_build_object('costo_prod', OLD.costo_prod);
      v_new := v_new || jsonb_build_object('costo_prod', NEW.costo_prod);
    END IF;
    IF NEW.costo_dev IS DISTINCT FROM OLD.costo_dev THEN
      changed := array_append(changed, 'costo_dev');
      v_old := v_old || jsonb_build_object('costo_dev', OLD.costo_dev);
      v_new := v_new || jsonb_build_object('costo_dev', NEW.costo_dev);
    END IF;
    IF NEW.nombre IS DISTINCT FROM OLD.nombre THEN
      changed := array_append(changed, 'nombre');
      v_old := v_old || jsonb_build_object('nombre', OLD.nombre);
      v_new := v_new || jsonb_build_object('nombre', NEW.nombre);
    END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone THEN
      changed := array_append(changed, 'phone');
      v_old := v_old || jsonb_build_object('phone', OLD.phone);
      v_new := v_new || jsonb_build_object('phone', NEW.phone);
    END IF;
    IF NEW.novedad IS DISTINCT FROM OLD.novedad THEN
      changed := array_append(changed, 'novedad');
    END IF;
    IF NEW.novedad_sol IS DISTINCT FROM OLD.novedad_sol THEN
      changed := array_append(changed, 'novedad_sol');
    END IF;
    IF NEW.guia IS DISTINCT FROM OLD.guia THEN
      changed := array_append(changed, 'guia');
    END IF;
    IF NEW.transportadora IS DISTINCT FROM OLD.transportadora THEN
      changed := array_append(changed, 'transportadora');
    END IF;
    IF NEW.fecha_conf IS DISTINCT FROM OLD.fecha_conf THEN
      changed := array_append(changed, 'fecha_conf');
    END IF;

    -- Solo log si hubo cambios en campos importantes
    IF array_length(changed, 1) > 0 THEN
      INSERT INTO public.audit_log (
        table_name, operation, row_id, old_data, new_data, changed_fields, user_id
      ) VALUES (
        'orders', 'UPDATE', NEW.id::text,
        CASE WHEN v_old = '{}'::jsonb THEN NULL ELSE v_old END,
        CASE WHEN v_new = '{}'::jsonb THEN NULL ELSE v_new END,
        changed,
        auth.uid()
      );
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;
