CREATE OR REPLACE FUNCTION public.delete_product_knowledge(
  p_store_id uuid,
  p_id       uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.product_knowledge WHERE id = p_id AND store_id = p_store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Producto no encontrado en esta tienda' USING ERRCODE = 'P0002';
  END IF;
END;
$$;