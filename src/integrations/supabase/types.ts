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
          store_id: string
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
          store_id?: string
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
          store_id?: string
          validated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "address_validations_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
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
          store_id: string
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
          store_id?: string
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
          store_id?: string
          table_name?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_runs: {
        Row: {
          created_at: string
          divergences_applied: number
          divergences_found: number
          dropi_count: number
          guardian_count: number
          id: string
          missing_in_dropi: number
          notes: string | null
          run_by: string
          store_id: string
        }
        Insert: {
          created_at?: string
          divergences_applied?: number
          divergences_found?: number
          dropi_count?: number
          guardian_count?: number
          id?: string
          missing_in_dropi?: number
          notes?: string | null
          run_by: string
          store_id: string
        }
        Update: {
          created_at?: string
          divergences_applied?: number
          divergences_found?: number
          dropi_count?: number
          guardian_count?: number
          id?: string
          missing_in_dropi?: number
          notes?: string | null
          run_by?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_runs_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      cfo_monthly_retrospective: {
        Row: {
          aciertos: string[]
          created_at: string
          decisiones: Json
          diagnostico_at: string | null
          diagnostico_auto: Json | null
          fugas: string[]
          id: string
          lecciones: string | null
          notas: string | null
          store_id: string
          updated_at: string
          year_month: string
        }
        Insert: {
          aciertos?: string[]
          created_at?: string
          decisiones?: Json
          diagnostico_at?: string | null
          diagnostico_auto?: Json | null
          fugas?: string[]
          id?: string
          lecciones?: string | null
          notas?: string | null
          store_id?: string
          updated_at?: string
          year_month: string
        }
        Update: {
          aciertos?: string[]
          created_at?: string
          decisiones?: Json
          diagnostico_at?: string | null
          diagnostico_auto?: Json | null
          fugas?: string[]
          id?: string
          lecciones?: string | null
          notas?: string | null
          store_id?: string
          updated_at?: string
          year_month?: string
        }
        Relationships: [
          {
            foreignKeyName: "cfo_monthly_retrospective_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_reports: {
        Row: {
          created_at: string
          data: Json
          id: string
          operator_id: string
          report_date: string
          report_type: string
          store_id: string
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          operator_id: string
          report_date?: string
          report_type: string
          store_id?: string
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          operator_id?: string
          report_date?: string
          report_type?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_reports_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
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
          store_id: string
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
          store_id?: string
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
          store_id?: string
          synced_at?: string
          synced_by?: string | null
          tipo?: string
        }
        Relationships: [
          {
            foreignKeyName: "dropi_wallet_movements_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_ad_spend: {
        Row: {
          account_name: string
          amount_cop: number
          created_at: string
          id: string
          notas: string | null
          payment_method: string
          platform: string
          store_id: string
          updated_at: string
          year_month: string
        }
        Insert: {
          account_name: string
          amount_cop?: number
          created_at?: string
          id?: string
          notas?: string | null
          payment_method?: string
          platform: string
          store_id?: string
          updated_at?: string
          year_month: string
        }
        Update: {
          account_name?: string
          amount_cop?: number
          created_at?: string
          id?: string
          notas?: string | null
          payment_method?: string
          platform?: string
          store_id?: string
          updated_at?: string
          year_month?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_ad_spend_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_business_inputs: {
        Row: {
          ads_meta: number
          ads_tiktok: number
          created_at: string
          id: string
          notas: string | null
          store_id: string
          tarjeta_interes: number
          tarjeta_pago: number
          updated_at: string
          year_month: string
        }
        Insert: {
          ads_meta?: number
          ads_tiktok?: number
          created_at?: string
          id?: string
          notas?: string | null
          store_id?: string
          tarjeta_interes?: number
          tarjeta_pago?: number
          updated_at?: string
          year_month: string
        }
        Update: {
          ads_meta?: number
          ads_tiktok?: number
          created_at?: string
          id?: string
          notas?: string | null
          store_id?: string
          tarjeta_interes?: number
          tarjeta_pago?: number
          updated_at?: string
          year_month?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_business_inputs_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      nightly_reconcile_results: {
        Row: {
          applied_count: number
          created_at: string
          divergent_count: number
          error_message: string | null
          id: string
          orphan_cancelled: number
          store_id: string
        }
        Insert: {
          applied_count?: number
          created_at?: string
          divergent_count?: number
          error_message?: string | null
          id?: string
          orphan_cancelled?: number
          store_id: string
        }
        Update: {
          applied_count?: number
          created_at?: string
          divergent_count?: number
          error_message?: string | null
          id?: string
          orphan_cancelled?: number
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nightly_reconcile_results_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          created_at: string
          id: string
          note_text: string
          operator_id: string
          order_id: string | null
          phone: string
          remind_at: string | null
          store_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          note_text: string
          operator_id: string
          order_id?: string | null
          phone: string
          remind_at?: string | null
          store_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          note_text?: string
          operator_id?: string
          order_id?: string | null
          phone?: string
          remind_at?: string | null
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_activity_daily: {
        Row: {
          active_seconds: number
          activity_date: string
          first_action_at: string
          idle_seconds: number
          last_active_at: string
          operator_id: string
          store_id: string
        }
        Insert: {
          active_seconds?: number
          activity_date: string
          first_action_at: string
          idle_seconds?: number
          last_active_at: string
          operator_id: string
          store_id: string
        }
        Update: {
          active_seconds?: number
          activity_date?: string
          first_action_at?: string
          idle_seconds?: number
          last_active_at?: string
          operator_id?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_activity_daily_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
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
          store_id: string
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
          store_id: string
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
          store_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_daily_reports_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_pool: {
        Row: {
          active: boolean
          created_at: string
          slot: number
          store_id: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          slot: number
          store_id?: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          slot?: number
          store_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_pool_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
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
          store_id: string
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
          store_id?: string
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
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_results_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_results_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
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
          last_movement_at: string | null
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
          store_id: string
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
          last_movement_at?: string | null
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
          store_id?: string
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
          last_movement_at?: string | null
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
          store_id?: string
          suggested_customer_message?: string | null
          tags?: string | null
          tienda?: string | null
          transportadora?: string | null
          upload_date?: string
          uploaded_by?: string
          validation_decision?: string | null
          valor?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_card_movements: {
        Row: {
          banco: string
          categoria: string
          created_at: string
          cuota_numero: number | null
          cuotas_total: number | null
          descripcion: string
          es_negocio: boolean
          fecha: string
          id: string
          interes_anual_pct: number | null
          interes_mensual_pct: number | null
          marca: string
          moneda: string
          monto: number
          notas: string | null
          numero_autorizacion: string | null
          origen_pdf: string | null
          periodo_corte_from: string | null
          periodo_corte_to: string | null
          raw_line: string | null
          saldo_pendiente: number | null
          store_id: string
          subcategoria: string | null
          tarjeta: string
          tipo: string
          updated_at: string
          valor_cuota: number | null
        }
        Insert: {
          banco?: string
          categoria?: string
          created_at?: string
          cuota_numero?: number | null
          cuotas_total?: number | null
          descripcion: string
          es_negocio?: boolean
          fecha: string
          id?: string
          interes_anual_pct?: number | null
          interes_mensual_pct?: number | null
          marca: string
          moneda: string
          monto: number
          notas?: string | null
          numero_autorizacion?: string | null
          origen_pdf?: string | null
          periodo_corte_from?: string | null
          periodo_corte_to?: string | null
          raw_line?: string | null
          saldo_pendiente?: number | null
          store_id?: string
          subcategoria?: string | null
          tarjeta: string
          tipo: string
          updated_at?: string
          valor_cuota?: number | null
        }
        Update: {
          banco?: string
          categoria?: string
          created_at?: string
          cuota_numero?: number | null
          cuotas_total?: number | null
          descripcion?: string
          es_negocio?: boolean
          fecha?: string
          id?: string
          interes_anual_pct?: number | null
          interes_mensual_pct?: number | null
          marca?: string
          moneda?: string
          monto?: number
          notas?: string | null
          numero_autorizacion?: string | null
          origen_pdf?: string | null
          periodo_corte_from?: string | null
          periodo_corte_to?: string | null
          raw_line?: string | null
          saldo_pendiente?: number | null
          store_id?: string
          subcategoria?: string | null
          tarjeta?: string
          tipo?: string
          updated_at?: string
          valor_cuota?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "personal_card_movements_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active_store_id: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_store_id?: string | null
          created_at?: string
          display_name: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active_store_id?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      shopify_product_dropi_map: {
        Row: {
          created_at: string
          created_by: string | null
          dropi_product_id: number
          dropi_variation_id: number | null
          shopify_product_id: number
          store_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dropi_product_id: number
          dropi_variation_id?: number | null
          shopify_product_id: number
          store_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dropi_product_id?: number
          dropi_variation_id?: number | null
          shopify_product_id?: number
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shopify_product_dropi_map_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_pushed_orders: {
        Row: {
          dropi_order_id: string | null
          error_message: string | null
          id: string
          payload: Json | null
          pushed_at: string
          pushed_by: string | null
          shopify_order_id: string
          status: string
          store_id: string
        }
        Insert: {
          dropi_order_id?: string | null
          error_message?: string | null
          id?: string
          payload?: Json | null
          pushed_at?: string
          pushed_by?: string | null
          shopify_order_id: string
          status?: string
          store_id: string
        }
        Update: {
          dropi_order_id?: string | null
          error_message?: string | null
          id?: string
          payload?: Json | null
          pushed_at?: string
          pushed_by?: string | null
          shopify_order_id?: string
          status?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shopify_pushed_orders_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      store_dropi_config: {
        Row: {
          country_code: string
          dropi_api_key: string | null
          dropi_session_token: string | null
          dropi_store_url: string | null
          last_health_checked_at: string | null
          last_health_status: string | null
          store_id: string
          updated_at: string
          white_brand_id: string | null
        }
        Insert: {
          country_code?: string
          dropi_api_key?: string | null
          dropi_session_token?: string | null
          dropi_store_url?: string | null
          last_health_checked_at?: string | null
          last_health_status?: string | null
          store_id: string
          updated_at?: string
          white_brand_id?: string | null
        }
        Update: {
          country_code?: string
          dropi_api_key?: string | null
          dropi_session_token?: string | null
          dropi_store_url?: string | null
          last_health_checked_at?: string | null
          last_health_status?: string | null
          store_id?: string
          updated_at?: string
          white_brand_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "store_dropi_config_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      store_invites: {
        Row: {
          created_at: string
          created_by: string
          email: string | null
          expires_at: string
          id: string
          role: string
          store_id: string
          token: string
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          email?: string | null
          expires_at?: string
          id?: string
          role?: string
          store_id: string
          token: string
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          email?: string | null
          expires_at?: string
          id?: string
          role?: string
          store_id?: string
          token?: string
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "store_invites_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      store_members: {
        Row: {
          created_at: string
          role: string
          store_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          role: string
          store_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          role?: string
          store_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_members_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      store_shopify_config: {
        Row: {
          active: boolean
          admin_token: string | null
          client_id: string | null
          client_secret: string | null
          shop_domain: string
          store_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          admin_token?: string | null
          client_id?: string | null
          client_secret?: string | null
          shop_domain: string
          store_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          admin_token?: string | null
          client_id?: string | null
          client_secret?: string | null
          shop_domain?: string
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_shopify_config_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          brand_logo_url: string | null
          country_code: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          status: string
        }
        Insert: {
          brand_logo_url?: string | null
          country_code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          status?: string
        }
        Update: {
          brand_logo_url?: string | null
          country_code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          status?: string
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
          store_id: string
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
          store_id?: string
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
          store_id?: string
          synced_count?: number
          total_count?: number
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_logs_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      tc_debt_snapshots: {
        Row: {
          created_at: string
          cupo_cop: number
          fecha_corte: string
          id: string
          notas: string | null
          saldo_cop: number
          saldo_usd: number
          source: string
          store_id: string
          tarjeta: string
          trm: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          cupo_cop?: number
          fecha_corte: string
          id?: string
          notas?: string | null
          saldo_cop?: number
          saldo_usd?: number
          source?: string
          store_id?: string
          tarjeta: string
          trm?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          cupo_cop?: number
          fecha_corte?: string
          id?: string
          notas?: string | null
          saldo_cop?: number
          saldo_usd?: number
          source?: string
          store_id?: string
          tarjeta?: string
          trm?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tc_debt_snapshots_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
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
          store_id: string
        }
        Insert: {
          action: string
          action_date?: string
          action_time?: string | null
          created_at?: string
          id?: string
          operator_id: string
          phone: string
          store_id?: string
        }
        Update: {
          action?: string
          action_date?: string
          action_time?: string | null
          created_at?: string
          id?: string
          operator_id?: string
          phone?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "touchpoints_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
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
      wa_ai_runs: {
        Row: {
          action: string | null
          completion_tokens: number | null
          confidence: string | null
          conversation_id: string | null
          created_at: string
          id: string
          model: string | null
          output: string | null
          prompt_tokens: number | null
          store_id: string
          trigger_message_id: string | null
        }
        Insert: {
          action?: string | null
          completion_tokens?: number | null
          confidence?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          model?: string | null
          output?: string | null
          prompt_tokens?: number | null
          store_id: string
          trigger_message_id?: string | null
        }
        Update: {
          action?: string | null
          completion_tokens?: number | null
          confidence?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          model?: string | null
          output?: string | null
          prompt_tokens?: number | null
          store_id?: string
          trigger_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wa_ai_runs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "wa_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_ai_runs_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_ai_runs_trigger_message_id_fkey"
            columns: ["trigger_message_id"]
            isOneToOne: false
            referencedRelation: "wa_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_channels: {
        Row: {
          created_at: string
          id: string
          instance_name: string | null
          meta: Json
          phone_number: string | null
          provider: string
          provider_base: string | null
          provider_token: string | null
          status: string
          store_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          instance_name?: string | null
          meta?: Json
          phone_number?: string | null
          provider?: string
          provider_base?: string | null
          provider_token?: string | null
          status?: string
          store_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          instance_name?: string | null
          meta?: Json
          phone_number?: string | null
          provider?: string
          provider_base?: string | null
          provider_token?: string | null
          status?: string
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wa_channels_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_conversations: {
        Row: {
          ai_enabled: boolean
          ai_state: string
          assigned_operator_id: string | null
          channel_id: string | null
          created_at: string
          customer_name: string | null
          customer_phone: string
          id: string
          last_direction: string | null
          last_message_at: string | null
          last_message_preview: string | null
          linked_external_id: string | null
          snooze_until: string | null
          status: string
          store_id: string
          unread_count: number
          updated_at: string
        }
        Insert: {
          ai_enabled?: boolean
          ai_state?: string
          assigned_operator_id?: string | null
          channel_id?: string | null
          created_at?: string
          customer_name?: string | null
          customer_phone: string
          id?: string
          last_direction?: string | null
          last_message_at?: string | null
          last_message_preview?: string | null
          linked_external_id?: string | null
          snooze_until?: string | null
          status?: string
          store_id: string
          unread_count?: number
          updated_at?: string
        }
        Update: {
          ai_enabled?: boolean
          ai_state?: string
          assigned_operator_id?: string | null
          channel_id?: string | null
          created_at?: string
          customer_name?: string | null
          customer_phone?: string
          id?: string
          last_direction?: string | null
          last_message_at?: string | null
          last_message_preview?: string | null
          linked_external_id?: string | null
          snooze_until?: string | null
          status?: string
          store_id?: string
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wa_conversations_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "wa_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_conversations_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_messages: {
        Row: {
          ai_generated: boolean
          body: string | null
          channel_id: string | null
          conversation_id: string
          created_at: string
          direction: string
          id: string
          media: Json | null
          operator_id: string | null
          provider_ts: string | null
          sender: string
          status: string
          store_id: string
          wa_message_id: string | null
        }
        Insert: {
          ai_generated?: boolean
          body?: string | null
          channel_id?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          id?: string
          media?: Json | null
          operator_id?: string | null
          provider_ts?: string | null
          sender?: string
          status?: string
          store_id: string
          wa_message_id?: string | null
        }
        Update: {
          ai_generated?: boolean
          body?: string | null
          channel_id?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          id?: string
          media?: Json | null
          operator_id?: string | null
          provider_ts?: string | null
          sender?: string
          status?: string
          store_id?: string
          wa_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wa_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "wa_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "wa_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_messages_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _resolve_scope_store: { Args: never; Returns: string }
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
          entrantes: number
          fecha: string
          noresp: number
          pct_cancelados: number
          pct_confirmacion: number
          pendientes: number
        }[]
      }
      admin_operator_actions_per_day: {
        Args: { p_from: string; p_to: string }
        Returns: {
          atendidos: number
          canc: number
          conf: number
          fecha: string
          noresp: number
          operadora: string
        }[]
      }
      admin_operator_shifts_range: {
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
          pedidos_nuevos: number
          pendientes_ayer: number
          pendientes_manana: number
          tipo: string
          total_gestionados: number
        }[]
      }
      auth_store_ids: { Args: never; Returns: string[] }
      cancel_orphan_pending_orders: { Args: never; Returns: number }
      categorize_personal_movement: {
        Args: { p_descripcion: string; p_moneda?: string }
        Returns: {
          categoria: string
          es_negocio: boolean
          subcategoria: string
        }[]
      }
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
          last_movement_at: string | null
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
          store_id: string
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
      create_store: {
        Args: { p_country_code: string; p_name: string }
        Returns: string
      }
      create_store_invite: {
        Args: { p_email?: string; p_role?: string; p_store_id: string }
        Returns: string
      }
      delete_monthly_ad_spend: { Args: { p_id: string }; Returns: boolean }
      delete_shopify_product_dropi_map: {
        Args: { p_shopify_product_id: number; p_store_id: string }
        Returns: undefined
      }
      dropi_fingerprint: { Args: { p_phone: string }; Returns: Json }
      financial_summary: {
        Args: { p_from_date: string; p_to_date: string }
        Returns: Json
      }
      get_cfo_retrospective: {
        Args: { p_year_month: string }
        Returns: {
          aciertos: string[]
          created_at: string
          decisiones: Json
          diagnostico_at: string | null
          diagnostico_auto: Json | null
          fugas: string[]
          id: string
          lecciones: string | null
          notas: string | null
          store_id: string
          updated_at: string
          year_month: string
        }
        SetofOptions: {
          from: "*"
          to: "cfo_monthly_retrospective"
          isOneToOne: true
          isSetofReturn: false
        }
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
      get_store_invite: {
        Args: { p_token: string }
        Returns: {
          country_code: string
          reason: string
          role: string
          store_name: string
          valid: boolean
        }[]
      }
      get_store_shopify_status: {
        Args: { p_store_id: string }
        Returns: {
          auth_mode: string
          configured: boolean
          shop_domain: string
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
      get_wa_channel_status: {
        Args: { p_store_id: string }
        Returns: {
          channel_id: string
          phone_number: string
          provider: string
          status: string
          updated_at: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_store_manager: { Args: { p_store_id: string }; Returns: boolean }
      is_store_member: { Args: { p_store_id: string }; Returns: boolean }
      is_store_owner: { Args: { p_store_id: string }; Returns: boolean }
      list_cfo_retrospectives: {
        Args: never
        Returns: {
          aciertos: string[]
          created_at: string
          decisiones: Json
          diagnostico_at: string | null
          diagnostico_auto: Json | null
          fugas: string[]
          id: string
          lecciones: string | null
          notas: string | null
          store_id: string
          updated_at: string
          year_month: string
        }[]
        SetofOptions: {
          from: "*"
          to: "cfo_monthly_retrospective"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      logistics_by_carrier:
        | {
            Args: { p_from_date: string; p_to_date: string }
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
        | {
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
      logistics_summary:
        | {
            Args: { p_from_date: string; p_to_date: string }
            Returns: {
              devueltos: number
              en_transito: number
              entregados: number
              tasa_devolucion: number
              tasa_entrega: number
              total_pedidos: number
              valor_entregado: number
              valor_perdido: number
            }[]
          }
        | {
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
      operator_activity_stats: {
        Args: { p_range?: string }
        Returns: {
          active_seconds: number
          display_name: string
          first_action_at: string
          idle_seconds: number
          last_active_at: string
          operator_id: string
        }[]
      }
      operator_productivity_stats: {
        Args: { p_range?: string }
        Returns: {
          cancelados: number
          confirmados: number
          display_name: string
          intentos_noresp: number
          intentos_total: number
          noresp: number
          novedades_resueltas: number
          operator_id: string
          pendientes_sin_tocar: number
          rescate_acciones: number
          rescate_pedidos: number
          rescate_resueltos: number
          rescate_resueltos_dist: number
          seg_acciones: number
          seg_pedidos: number
          seg_resueltos: number
          seg_resueltos_dist: number
          tasa_confirmacion: number
          tasa_contacto: number
          total_atendidos: number
          total_entrantes: number
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
      orders_estado_breakdown: {
        Args: { p_from: string; p_to: string }
        Returns: {
          estado: string
          pedidos: number
          unidades: number
          valor: number
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
      personal_payments_summary: {
        Args: { p_from_date?: string; p_to_date?: string }
        Returns: {
          avances_cop: number
          avances_usd: number
          comisiones_cop: number
          compras_cop: number
          compras_usd: number
          count_movimientos: number
          intereses_cop: number
          intereses_usd: number
          pagos_cop: number
          pagos_usd: number
          year_month: string
        }[]
      }
      personal_residual_debt: {
        Args: never
        Returns: {
          marca: string
          moneda: string
          num_compras: number
          saldo_pendiente: number
          tarjeta: string
        }[]
      }
      personal_spending_by_month: {
        Args: { p_from_date?: string; p_to_date?: string }
        Returns: {
          categoria: string
          cuotas_diferidas: number
          es_negocio: boolean
          monto_cop: number
          total_count: number
          total_monto: number
          year_month: string
        }[]
      }
      personal_spending_top_items: {
        Args: { p_categoria?: string; p_limit?: number; p_year_month: string }
        Returns: {
          categoria: string
          cuotas_total: number
          descripcion: string
          es_negocio: boolean
          fecha: string
          id: string
          interes_anual_pct: number
          marca: string
          moneda: string
          monto: number
          monto_cop: number
          subcategoria: string
          tarjeta: string
        }[]
      }
      product_profitability: {
        Args: { p_from_date: string; p_limit?: number; p_to_date: string }
        Returns: {
          cancelados: number
          costo_devolucion_total: number
          costo_prod_entregados: number
          devueltos: number
          en_transito: number
          entregados: number
          flete_inicial_entregados: number
          ingresos_entregados: number
          margen_pct: number
          producto: string
          tasa_cancelacion: number
          tasa_devolucion: number
          tasa_entrega: number
          ticket_promedio: number
          total_pedidos: number
          utilidad_proyectada: number
          utilidad_real: number
        }[]
      }
      recategorize_personal_movements: { Args: never; Returns: Json }
      record_operator_heartbeat: {
        Args: {
          p_active_seconds: number
          p_idle_seconds: number
          p_store_id: string
        }
        Returns: undefined
      }
      redeem_store_invite: { Args: { p_token: string }; Returns: string }
      release_order: { Args: { p_order_id: string }; Returns: undefined }
      release_seg_order: { Args: { p_order_id: string }; Returns: boolean }
      set_active_store: { Args: { p_store_id: string }; Returns: undefined }
      snapshot_cfo_diagnostico: {
        Args: { p_year_month: string }
        Returns: {
          aciertos: string[]
          created_at: string
          decisiones: Json
          diagnostico_at: string | null
          diagnostico_auto: Json | null
          fugas: string[]
          id: string
          lecciones: string | null
          notas: string | null
          store_id: string
          updated_at: string
          year_month: string
        }
        SetofOptions: {
          from: "*"
          to: "cfo_monthly_retrospective"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      store_role: { Args: { p_store_id: string }; Returns: string }
      submit_closing_report: {
        Args: { p_force?: boolean; p_notes?: string }
        Returns: undefined
      }
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
      update_store_branding: {
        Args: { p_brand_logo_url: string; p_name: string; p_store_id: string }
        Returns: undefined
      }
      upsert_cfo_retrospective: {
        Args: {
          p_aciertos: Json
          p_decisiones: Json
          p_fugas: Json
          p_lecciones: string
          p_notas: string
          p_year_month: string
        }
        Returns: {
          aciertos: string[]
          created_at: string
          decisiones: Json
          diagnostico_at: string | null
          diagnostico_auto: Json | null
          fugas: string[]
          id: string
          lecciones: string | null
          notas: string | null
          store_id: string
          updated_at: string
          year_month: string
        }
        SetofOptions: {
          from: "*"
          to: "cfo_monthly_retrospective"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_monthly_ad_spend: {
        Args: {
          p_account_name: string
          p_amount_cop: number
          p_notas: string
          p_payment_method: string
          p_platform: string
          p_year_month: string
        }
        Returns: {
          account_name: string
          amount_cop: number
          created_at: string
          id: string
          notas: string | null
          payment_method: string
          platform: string
          store_id: string
          updated_at: string
          year_month: string
        }
        SetofOptions: {
          from: "*"
          to: "monthly_ad_spend"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_monthly_business_inputs: {
        Args: {
          p_ads_meta: number
          p_ads_tiktok: number
          p_notas: string
          p_tarjeta_interes: number
          p_tarjeta_pago: number
          p_year_month: string
        }
        Returns: {
          ads_meta: number
          ads_tiktok: number
          created_at: string
          id: string
          notas: string | null
          store_id: string
          tarjeta_interes: number
          tarjeta_pago: number
          updated_at: string
          year_month: string
        }
        SetofOptions: {
          from: "*"
          to: "monthly_business_inputs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_orders_from_dropi: { Args: { p_orders: Json }; Returns: number }
      upsert_personal_card_movements: {
        Args: { p_movements: Json }
        Returns: Json
      }
      upsert_shopify_product_dropi_map: {
        Args: {
          p_dropi_product_id: number
          p_dropi_variation_id?: number
          p_shopify_product_id: number
          p_store_id: string
        }
        Returns: undefined
      }
      upsert_store_dropi_config: {
        Args: {
          p_country_code: string
          p_dropi_api_key: string
          p_dropi_session_token: string
          p_dropi_store_url: string
          p_store_id: string
        }
        Returns: undefined
      }
      upsert_store_shopify_config: {
        Args: {
          p_admin_token: string
          p_shop_domain: string
          p_store_id: string
        }
        Returns: undefined
      }
      upsert_store_shopify_credentials: {
        Args: {
          p_client_id: string
          p_client_secret: string
          p_shop_domain: string
          p_store_id: string
        }
        Returns: undefined
      }
      upsert_tc_debt_snapshot: {
        Args: {
          p_cupo_cop: number
          p_fecha_corte: string
          p_notas: string
          p_saldo_cop: number
          p_saldo_usd: number
          p_source: string
          p_tarjeta: string
          p_trm: number
        }
        Returns: {
          created_at: string
          cupo_cop: number
          fecha_corte: string
          id: string
          notas: string | null
          saldo_cop: number
          saldo_usd: number
          source: string
          store_id: string
          tarjeta: string
          trm: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tc_debt_snapshots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_wa_channel: {
        Args: {
          p_instance_name?: string
          p_phone_number?: string
          p_provider: string
          p_provider_base?: string
          p_provider_token: string
          p_store_id: string
        }
        Returns: string
      }
      upsert_wallet_movements: { Args: { p_movements: Json }; Returns: number }
      wallet_daily_series: {
        Args: { p_from: string; p_to: string }
        Returns: {
          entrada: number
          fecha: string
          salida: number
        }[]
      }
      wallet_ganancia_neta: {
        Args: { p_from: string; p_to: string }
        Returns: {
          comision_referidos: number
          costo_devolucion: number
          flete_inicial: number
          ganancia_dropshipper: number
          ganancia_neta: number
          ganancia_proveedor: number
          indemnizacion: number
          mantenimiento_tarjeta: number
          movimientos_count: number
          orden_sin_recaudo: number
          reembolso_flete: number
          total_entradas: number
          total_salidas: number
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
