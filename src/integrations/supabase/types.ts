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
      order_results: {
        Row: {
          created_at: string
          id: string
          module: string
          operator_id: string
          order_id: string
          phone: string
          reason: string | null
          result: string
          result_date: string
          result_time: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          module?: string
          operator_id: string
          order_id: string
          phone: string
          reason?: string | null
          result: string
          result_date?: string
          result_time?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          module?: string
          operator_id?: string
          order_id?: string
          phone?: string
          reason?: string | null
          result?: string
          result_date?: string
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
          assigned_to: string | null
          cantidad: number | null
          ciudad: string | null
          costo_dev: number | null
          costo_prod: number | null
          created_at: string
          departamento: string | null
          dias: number | null
          dias_conf: number | null
          direccion: string | null
          estado: string | null
          external_id: string | null
          fecha: string | null
          fecha_conf: string | null
          flete: number | null
          guia: string | null
          id: string
          nombre: string
          novedad: string | null
          novedad_sol: boolean | null
          phone: string
          producto: string | null
          tags: string | null
          tienda: string | null
          transportadora: string | null
          upload_date: string
          uploaded_by: string
          valor: number | null
        }
        Insert: {
          assigned_to?: string | null
          cantidad?: number | null
          ciudad?: string | null
          costo_dev?: number | null
          costo_prod?: number | null
          created_at?: string
          departamento?: string | null
          dias?: number | null
          dias_conf?: number | null
          direccion?: string | null
          estado?: string | null
          external_id?: string | null
          fecha?: string | null
          fecha_conf?: string | null
          flete?: number | null
          guia?: string | null
          id?: string
          nombre: string
          novedad?: string | null
          novedad_sol?: boolean | null
          phone: string
          producto?: string | null
          tags?: string | null
          tienda?: string | null
          transportadora?: string | null
          upload_date?: string
          uploaded_by: string
          valor?: number | null
        }
        Update: {
          assigned_to?: string | null
          cantidad?: number | null
          ciudad?: string | null
          costo_dev?: number | null
          costo_prod?: number | null
          created_at?: string
          departamento?: string | null
          dias?: number | null
          dias_conf?: number | null
          direccion?: string | null
          estado?: string | null
          external_id?: string | null
          fecha?: string | null
          fecha_conf?: string | null
          flete?: number | null
          guia?: string | null
          id?: string
          nombre?: string
          novedad?: string | null
          novedad_sol?: boolean | null
          phone?: string
          producto?: string | null
          tags?: string | null
          tienda?: string | null
          transportadora?: string | null
          upload_date?: string
          uploaded_by?: string
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
      dropi_fingerprint: { Args: { p_phone: string }; Returns: Json }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
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
