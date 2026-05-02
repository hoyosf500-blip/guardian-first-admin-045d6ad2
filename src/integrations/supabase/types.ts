export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      address_autocomplete_cache: {
        Row: {
          ciudad_filter: string | null
          created_at: string
          expires_at: string
          hit_count: number
          id: number
          query_normalized: string
          suggestions: Json
        }
        Insert: {
          ciudad_filter?: string | null
          created_at?: string
          expires_at: string
          hit_count?: number
          id?: number
          query_normalized: string
          suggestions: Json
        }
        Update: {
          ciudad_filter?: string | null
          created_at?: string
          expires_at?: string
          hit_count?: number
          id?: number
          query_normalized?: string
          suggestions?: Json
        }
        Relationships: []
      }
      address_validations: {
        Row: {
          cache_key: string
          ciudad: string | null
          departamento: string | null
          direccion: string
          geocoded_display: string | null
          geocoded_lat: number | null
          geocoded_lng: number | null
          id: string
          issues: string[]
          score: number
          status: string
          validated_at: string
        }
        Insert: {
          cache_key: string
          ciudad?: string | null
          departamento?: string | null
          direccion: string
          geocoded_display?: string | null
          geocoded_lat?: number | null
          geocoded_lng?: number | null
          id?: string
          issues?: string[]
          score: number
          status: string
          validated_at?: string
        }
        Update: {
          cache_key?: string
          ciudad?: string | null
          departamento?: string | null
          direccion?: string
          geocoded_display?: string | null
          geocoded_lat?: number | null
          geocoded_lng?: number | null
          id?: string
          issues?: string[]
          score?: number
          status?: string
          validated_at?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          created_at: string
          id: string
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          changed_fields: string[] | null
          created_at: string
          id: string
          new_data: Json | null
          old_data: Json | null
          operation: string
          row_id: string
          table_name: string
          user_id: string | null
        }
        Insert: {
          changed_fields?: string[] | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          operation: string
          row_id: string
          table_name: string
          user_id?: string | null
        }
        Update: {
          changed_fields?: string[] | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          operation?: string
          row_id?: string
          table_name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      daily_reports: {
        Row: {
          created_at: string
          data: Json
          id: string
          operator_id: string
          report_date: string
          report_type: string
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          operator_id: string
          report_date?: string
          report_type: string
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          operator_id?: string
          report_date?: string
          report_type?: string
        }
        Relationships: []
      }
      dropi_wallet_movements: {
        Row: {
          categoria: string | null
          codigo: string | null
          concepto_retiro: string | null
          cuenta: string | null
          descripcion: string | null
          dropi_transaction_id: number
          fecha: string
          id: number
          monto: number
          monto_previo: number | null
          raw: Json
          related_order_id: string | null
          saldo_despues: number | null
          synced_at: string
          synced_by: string | null
          tipo: string
        }
        Insert: {
          categoria?: string | null
          codigo?: string | null
          concepto_retiro?: string | null
          cuenta?: string | null
          descripcion?: string | null
          dropi_transaction_id: number
          fecha: string
          id?: number
          monto: number
          monto_previo?: number | null
          raw: Json
          related_order_id?: string | null
          saldo_despues?: number | null
          synced_at?: string
          synced_by?: string | null
          tipo: string
        }
        Update: {
          categoria?: string | null
          codigo?: string | null
          concepto_retiro?: string | null
          cuenta?: string | null
          descripcion?: string | null
          dropi_transaction_id?: number
          fecha?: string
          id?: number
          monto?: number
          monto_previo?: number | null
          raw?: Json
          related_order_id?: string | null
          saldo_despues?: number | null
          synced_at?: string
          synced_by?: string | null
          tipo?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          created_at: string
          id: string
          note_text: string
          operator_id: string
          order_id: string | null
          phone: string
        }
        Insert: {
          created_at?: string
          id?: string
          note_text: string
          operator_id: string
          order_id?: string | null
          phone: string
        }
        Update: {
          created_at?: string
          id?: string
          note_text?: string
          operator_id?: string
          order_id?: string | null
          phone?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_daily_reports: {
        Row: {
          closing_at: string | null
          closing_cancelados: number | null
          closing_confirmados: number | null
          closing_noresp: number | null
          closing_notes: string | null
          closing_pending_tomorrow: number | null
          created_at: string
          id: string
          opening_at: string | null
          opening_guides_yesterday: number | null
          opening_new_orders: number | null
          opening_notes: string | null
          opening_pending_yesterday: number | null
          report_date: string
          user_id: string
        }
        Insert: {
          closing_at?: string | null
          closing_cancelados?: number | null
          closing_confirmados?: number | null
          closing_noresp?: number | null
          closing_notes?: string | null
          closing_pending_tomorrow?: number | null
          created_at?: string
          id?: string
          opening_at?: string | null
          opening_guides_yesterday?: number | null
          opening_new_orders?: number | null
          opening_notes?: string | null
          opening_pending_yesterday?: number | null
          report_date: string
          user_id: string
        }
        Update: {
          closing_at?: string | null
          closing_cancelados?: number | null
          closing_confirmados?: number | null
          closing_noresp?: number | null
          closing_notes?: string | null
          closing_pending_tomorrow?: number | null
          created_at?: string
          id?: string
          opening_at?: string | null
          opening_guides_yesterday?: number | null
          opening_new_orders?: number | null
          opening_notes?: string | null
          opening_pending_yesterday?: number | null
          report_date?: string
          user_id?: string
        }
        Relationships: []
      }
      operator_pool: {
        Row: {
          active: boolean
          created_at: string
          slot: number
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          slot: number
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          slot?: number
          user_id?: string
        }
        Relationships: []
      }
      order_results: {
        Row: {
          created_at: string
          dropi_sync_status: string
          id: string
          module: string
          operator_id: string
          order_id: string
          phone: string
          reason: string | null
          result: string
          result_date: string
          result_notes: string | null
          result_time: string | null
        }
        Insert: {
          created_at?: string
          dropi_sync_status?: string
          id?: string
          module?: string
          operator_id: string
          order_id: string
          phone: string
          reason?: string | null
          result: string
          result_date?: string
          result_notes?: string | null
          result_time?: string | null
        }
        Update: {
          created_at?: string
          dropi_sync_status?: string
          id?: string
          module?: string
          operator_id?: string
          order_id?: string
          phone?: string
          reason?: string | null
          result?: string
          result_date?: string
          result_notes?: string | null
          result_time?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_results_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          address_kind: string | null
          address_parsed: Json | null
          assigned_to: string | null
          barrio: string | null
          cantidad: number | null
          ciudad: string | null
          complemento: string | null
          costo_dev: number | null
          costo_prod: number | null
          created_at: string
          departamento: string | null
          dias: number | null
          dias_conf: number | null
          direccion: string | null
          documento_destinatario: string | null
          email: string | null
          estado: string | null
          external_id: string | null
          fecha: string | null
          fecha_conf: string | null
          flete: number | null
          google_place_id: string | null
          guia: string | null
          id: string
          last_edit_sync_at: string | null
          last_edited_by: string | null
          lat: number | null
          lng: number | null
          locked_at: string | null
          locked_by: string | null
          missing_fields: Json | null
          nombre: string
          novedad: string | null
          novedad_sol: boolean | null
          phone: string
          producto: string | null
          suggested_customer_message: string | null
          tags: string | null
          tienda: string | null
          transportadora: string | null
          upload_date: string
          uploaded_by: string
          validation_decision: string | null
          valor: number | null
        }
        Insert: {
          address_kind?: string | null
          address_parsed?: Json | null
          assigned_to?: string | null
          barrio?: string | null
          cantidad?: number | null
          ciudad?: string | null
          complemento?: string | null
          costo_dev?: number | null
          costo_prod?: number | null
          created_at?: string
          departamento?: string | null
          dias?: number | null
          dias_conf?: number | null
          direccion?: string | null
          documento_destinatario?: string | null
          email?: string | null
          estado?: string | null
          external_id?: string | null
          fecha?: string | null
          fecha_conf?: string | null
          flete?: number | null
          google_place_id?: string | null
          guia?: string | null
          id?: string
          last_edit_sync_at?: string | null
          last_edited_by?: string | null
          lat?: number | null
          lng?: number | null
          locked_at?: string | null
          locked_by?: string | null
          missing_fields?: Json | null
          nombre: string
          novedad?: string | null
          novedad_sol?: boolean | null
          phone: string
          producto?: string | null
          suggested_customer_message?: string | null
          tags?: string | null
          tienda?: string | null
          transportadora?: string | null
          upload_date?: string
          uploaded_by: string
          validation_decision?: string | null
          valor?: number | null
        }
        Update: {
          address_kind?: string | null
          address_parsed?: Json | null
          assigned_to?: string | null
          barrio?: string | null
          cantidad?: number | null
          ciudad?: string | null
          complemento?: string | null
          costo_dev?: number | null
          costo_prod?: number | null
          created_at?: string
          departamento?: string | null
          dias?: number | null
          dias_conf?: number | null
          direccion?: string | null
          documento_destinatario?: string | null
          email?: string | null
          estado?: string | null
          external_id?: string | null
          fecha?: string | null
          fecha_conf?: string | null
          flete?: number | null
          google_place_id?: string | null
          guia?: string | null
          id?: string
          last_edit_sync_at?: string | null
          last_edited_by?: string | null
          lat?: number | null
          lng?: number | null
          locked_at?: string | null
          locked_by?: string | null
          missing_fields?: Json | null
          nombre?: string
          novedad?: string | null
          novedad_sol?: boolean | null
          phone?: string
          producto?: string | null
          suggested_customer_message?: string | null
          tags?: string | null
          tienda?: string | null
          transportadora?: string | null
          upload_date?: string
          uploaded_by?: string
          validation_decision?: string | null
          valor?: number | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_logs: {
        Row: {
          created_at: string
          duplicates_count: number
          error_message: string | null
          id: string
          source: string
          status: string
          synced_count: number
          total_count: number
          triggered_by: string | null
        }
        Insert: {
          created_at?: string
          duplicates_count?: number
          error_message?: string | null
          id?: string
          source?: string
          status?: string
          synced_count?: number
          total_count?: number
          triggered_by?: string | null
        }
        Update: {
          created_at?: string
          duplicates_count?: number
          error_message?: string | null
          id?: string
          source?: string
          status?: string
          synced_count?: number
          total_count?: number
          triggered_by?: string | null
        }
        Relationships: []
      }
      touchpoints: {
        Row: {
          action: string
          action_date: string
          action_time: string | null
          created_at: string
          id: string
          operator_id: string
          phone: string
        }
        Insert: {
          action: string
          action_date?: string
          action_time?: string | null
          created_at?: string
          id?: string
          operator_id: string
          phone: string
        }
        Update: {
          action?: string
          action_date?: string
          action_time?: string | null
          created_at?: string
          id?: string
          operator_id?: string
          phone?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_daily_reports: {
        Args: { p_date: string }
        Returns: {
          cancelados: number
          closing_at: string
          closing_notes: string
          confirmados: number
          display_name: string
          noresp: number
          opening_at: string
          opening_guides_yesterday: number
          opening_new_orders: number
          opening_notes: string
          opening_pending_yesterday: number
          status: string
          tasa_confirmacion: number
          user_id: string
        }[]
      }
      admin_daily_reports_range: {
        Args: { p_from: string; p_to: string }
        Returns: {
          cancelados: number
          confirmados: number
          fecha: string
          guias_apertura: number
          hora: string
          noresp: number
          notas: string
          operadora: string
          pct_cancelados: number
          pct_confirmacion: number
          pedidos_nuevos: number
          pendientes_ayer: number
          pendientes_manana: number
          tipo: string
          total_gestionados: number
        }[]
      }
      cancel_orphan_pending_orders: { Args: never; Returns: number }
      claim_order: {
        Args: { p_order_id: string }
        Returns: {
          address_kind: string | null
          address_parsed: Json | null
          assigned_to: string | null
          barrio: string | null
          cantidad: number | null
          ciudad: string | null
          complemento: string | null
          costo_dev: number | null
          costo_prod: number | null
          created_at: string
          departamento: string | null
          dias: number | null
          dias_conf: number | null
          direccion: string | null
          documento_destinatario: string | null
          email: string | null
          estado: string | null
          external_id: string | null
          fecha: string | null
          fecha_conf: string | null
          flete: number | null
          google_place_id: string | null
          guia: string | null
          id: string
          last_edit_sync_at: string | null
          last_edited_by: string | null
          lat: number | null
          lng: number | null
          locked_at: string | null
          locked_by: string | null
          missing_fields: Json | null
          nombre: string
          novedad: string | null
          novedad_sol: boolean | null
          phone: string
          producto: string | null
          suggested_customer_message: string | null
          tags: string | null
          tienda: string | null
          transportadora: string | null
          upload_date: string
          uploaded_by: string
          validation_decision: string | null
          valor: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_seg_order: { Args: { p_order_id: string }; Returns: boolean }
      cleanup_expired_autocomplete_cache: { Args: never; Returns: number }
      cleanup_old_logs: { Args: never; Returns: Json }
      confirm_order_locally: { Args: { p_order_id: string }; Returns: boolean }
      consume_google_quota: { Args: { p_amount_usd: number }; Returns: boolean }
      dropi_fingerprint: { Args: { p_phone: string }; Returns: Json }
      financial_summary: {
        Args: { p_from_date: string; p_to_date: string }
        Returns: Json
      }
      get_daily_operator_stats: {
        Args: { p_date: string }
        Returns: {
          canc: number
          conf: number
          display_name: string
          noresp: number
          operator_id: string
        }[]
      }
      get_top_cities: {
        Args: { p_limit?: number }
        Returns: {
          ciudad: string
          departamento: string
          total_pedidos: number
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      logistics_by_carrier: {
        Args: { p_ciudad?: string; p_from_date: string; p_to_date: string }
        Returns: {
          avg_dias_entrega: number
          devueltos: number
          en_transito: number
          entregados: number
          novedades: number
          tasa_devolucion: number
          tasa_entrega: number
          total_pedidos: number
          transportadora: string
          valor_entregado: number
          valor_perdido: number
        }[]
      }
      logistics_by_city: {
        Args: { p_from_date: string; p_limit?: number; p_to_date: string }
        Returns: {
          ciudad: string
          departamento: string
          devueltos: number
          entregados: number
          tasa_devolucion: number
          tasa_entrega: number
          total_pedidos: number
          valor_perdido: number
        }[]
      }
      logistics_by_city_carrier: {
        Args: {
          p_from_date: string
          p_min_orders?: number
          p_to_date: string
          p_top_cities?: number
        }
        Returns: {
          ciudad: string
          ciudad_total: number
          departamento: string
          devueltos: number
          entregados: number
          tasa_devolucion: number
          tasa_entrega: number
          total_pedidos: number
          transportadora: string
        }[]
      }
      logistics_by_product: {
        Args: { p_from_date: string; p_limit?: number; p_to_date: string }
        Returns: {
          devueltos: number
          entregados: number
          producto: string
          tasa_devolucion: number
          tasa_entrega: number
          total_pedidos: number
          valor_entregado: number
          valor_perdido: number
        }[]
      }
      logistics_dashboard: { Args: { p_range?: string }; Returns: Json }
      logistics_recommendations: {
        Args: { p_from_date: string; p_min_orders?: number; p_to_date: string }
        Returns: {
          carrier_actual_top: string
          ciudad: string
          ciudad_total: number
          delta_puntos: number
          departamento: string
          mejor_pedidos: number
          mejor_tasa_entrega: number
          mejor_transportadora: string
          peor_pedidos: number
          peor_tasa_entrega: number
          peor_transportadora: string
          recomendacion: string
        }[]
      }
      logistics_summary: {
        Args: { p_ciudad?: string; p_from_date: string; p_to_date: string }
        Returns: {
          cancelados: number
          devueltos: number
          en_transito: number
          entregados: number
          novedades: number
          pendientes_por_confirmar: number
          pendientes_sin_despachar: number
          tasa_devolucion: number
          tasa_entrega: number
          total_pedidos: number
          valor_cancelado: number
          valor_en_transito: number
          valor_entregado: number
          valor_novedades: number
          valor_pendientes: number
          valor_perdido: number
        }[]
      }
      logistics_timeline: {
        Args: {
          p_estados?: string[]
          p_from_date: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_to_date: string
          p_transportadora?: string
        }
        Returns: {
          ciudad: string
          estado: string
          external_id: string
          fecha: string
          guia: string
          id: string
          producto: string
          total_count: number
          transportadora: string
          valor: number
        }[]
      }
      opening_report_status: {
        Args: never
        Returns: {
          has_closing: boolean
          has_opening: boolean
        }[]
      }
      operator_productivity_stats: {
        Args: { p_range?: string }
        Returns: {
          cancelados: number
          confirmados: number
          display_name: string
          noresp: number
          novedades_resueltas: number
          operator_id: string
          rescate_acciones: number
          rescate_resueltos: number
          seg_acciones: number
          seg_resueltos: number
          tasa_confirmacion: number
          tasa_contacto: number
          total_atendidos: number
        }[]
      }
      operator_today_tasa: {
        Args: never
        Returns: {
          cancelados: number
          confirmados: number
          noresp: number
          tasa_confirmacion: number
          total: number
        }[]
      }
      pending_retry_list: {
        Args: never
        Returns: {
          attempts: number
          external_id: string
          nombre: string
          phone: string
        }[]
      }
      pending_tomorrow_count: { Args: never; Returns: number }
      release_order: { Args: { p_order_id: string }; Returns: undefined }
      release_seg_order: { Args: { p_order_id: string }; Returns: boolean }
      submit_closing_report: { Args: { p_notes?: string }; Returns: undefined }
      submit_opening_report: {
        Args: {
          p_guides_yesterday: number
          p_new_orders: number
          p_notes?: string
          p_pending_yesterday: number
        }
        Returns: undefined
      }
      today_call_stats: {
        Args: never
        Returns: {
          cancelados: number
          confirmados: number
          noresp: number
          pending_tomorrow: number
          tasa_conf: number
          total: number
        }[]
      }
      upsert_orders_from_dropi: { Args: { p_orders: Json }; Returns: number }
      upsert_wallet_movements: { Args: { p_movements: Json }; Returns: number }
      wallet_daily_series: {
        Args: { p_from: string; p_to: string }
        Returns: {
          entrada: number
          fecha: string
          salida: number
        }[]
      }
      wallet_summary: {
        Args: { p_from: string; p_to: string }
        Returns: {
          categorias: string[]
          count_total: number
          total_entradas: number
          total_salidas: number
          ultimo_saldo: number
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "operator"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operator"],
    },
  },
} as const
