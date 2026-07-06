INSERT INTO public.store_members (store_id, user_id, role)
SELECT '512309c3-d5b7-4434-898a-31bed51dcd4d', '7f8b1a67-fe3f-4628-a5ca-32e8c945dade', 'operator'
WHERE NOT EXISTS (
  SELECT 1 FROM public.store_members
  WHERE store_id='512309c3-d5b7-4434-898a-31bed51dcd4d'
    AND user_id='7f8b1a67-fe3f-4628-a5ca-32e8c945dade'
);