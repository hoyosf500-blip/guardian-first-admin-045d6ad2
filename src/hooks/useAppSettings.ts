import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Claves críticas que el wizard exige antes de habilitar el resto del CRM.
export const REQUIRED_SETTING_KEYS = [
  'brand_name',
  'dropi_token',
  'dropi_session_token',
  'dropi_white_brand_id',
  'dropi_store_url',
] as const;

export const OPTIONAL_SETTING_KEYS = ['brand_logo_url'] as const;

export type SettingKey =
  | (typeof REQUIRED_SETTING_KEYS)[number]
  | (typeof OPTIONAL_SETTING_KEYS)[number];

export interface AppSettingsState {
  values: Record<string, string>;
  loading: boolean;
  needsSetup: boolean;
  brandName: string;
  brandLogoUrl: string | null;
  refresh: () => Promise<void>;
}

/**
 * Lee app_settings (RLS admin-only en este proyecto). Para operadoras
 * la query devuelve 0 filas — eso está OK: ProtectedLayout decide qué
 * mostrar según el rol.
 */
export function useAppSettings(): AppSettingsState {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const keys = [...REQUIRED_SETTING_KEYS, ...OPTIONAL_SETTING_KEYS];
    const { data } = await supabase
      .from('app_settings')
      .select('key, value')
      .in('key', keys);
    const map: Record<string, string> = {};
    (data ?? []).forEach((r: { key: string; value: string | null }) => {
      map[r.key] = r.value ?? '';
    });
    setValues(map);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const needsSetup = REQUIRED_SETTING_KEYS.some(k => !(values[k] ?? '').trim());
  const brandName = (values.brand_name ?? '').trim() || 'CRM';
  const brandLogoUrl = (values.brand_logo_url ?? '').trim() || null;

  return { values, loading, needsSetup, brandName, brandLogoUrl, refresh };
}
