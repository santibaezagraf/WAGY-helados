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
      actividad_usuario: {
        Row: {
          accion: string
          cantidad: number
          created_at: string
          detalle: Json | null
          id: number
          pedido_id: number | null
          usuario_id: string
          usuario_nombre: string
        }
        Insert: {
          accion: string
          cantidad?: number
          created_at?: string
          detalle?: Json | null
          id?: never
          pedido_id?: number | null
          usuario_id: string
          usuario_nombre: string
        }
        Update: {
          accion?: string
          cantidad?: number
          created_at?: string
          detalle?: Json | null
          id?: never
          pedido_id?: number | null
          usuario_id?: string
          usuario_nombre?: string
        }
        Relationships: []
      }
      alertas_modelo: {
        Row: {
          created_at: string
          id: number
          modelo_agotado: string
          modelo_fallback: string | null
          resuelto: boolean
          telefono: string | null
        }
        Insert: {
          created_at?: string
          id?: never
          modelo_agotado: string
          modelo_fallback?: string | null
          resuelto?: boolean
          telefono?: string | null
        }
        Update: {
          created_at?: string
          id?: never
          modelo_agotado?: string
          modelo_fallback?: string | null
          resuelto?: boolean
          telefono?: string | null
        }
        Relationships: []
      }
      atencion_humana: {
        Row: {
          activa: boolean
          bloqueado: boolean
          motivo_atencion: string | null
          rate_limit_reset_at: string | null
          requiere_atencion: boolean
          requiere_atencion_at: string | null
          telefono: string
          updated_at: string
        }
        Insert: {
          activa?: boolean
          bloqueado?: boolean
          motivo_atencion?: string | null
          rate_limit_reset_at?: string | null
          requiere_atencion?: boolean
          requiere_atencion_at?: string | null
          telefono: string
          updated_at?: string
        }
        Update: {
          activa?: boolean
          bloqueado?: boolean
          motivo_atencion?: string | null
          rate_limit_reset_at?: string | null
          requiere_atencion?: boolean
          requiere_atencion_at?: string | null
          telefono?: string
          updated_at?: string
        }
        Relationships: []
      }
      gastos: {
        Row: {
          activo: boolean
          concepto: string | null
          created_at: string
          id: number
          monto: number
        }
        Insert: {
          activo?: boolean
          concepto?: string | null
          created_at?: string
          id?: number
          monto: number
        }
        Update: {
          activo?: boolean
          concepto?: string | null
          created_at?: string
          id?: number
          monto?: number
        }
        Relationships: []
      }
      listas_precios: {
        Row: {
          activa: boolean | null
          created_at: string
          id: number
          nombre: string | null
          sabores_agua: Json | null
          sabores_crema: Json | null
        }
        Insert: {
          activa?: boolean | null
          created_at?: string
          id?: number
          nombre?: string | null
          sabores_agua?: Json | null
          sabores_crema?: Json | null
        }
        Update: {
          activa?: boolean | null
          created_at?: string
          id?: number
          nombre?: string | null
          sabores_agua?: Json | null
          sabores_crema?: Json | null
        }
        Relationships: []
      }
      mensajes_chat: {
        Row: {
          created_at: string
          descartado: boolean
          fallido: boolean
          id: string
          media_caption: string | null
          media_filename: string | null
          media_lat: number | null
          media_lng: number | null
          media_mime: string | null
          media_path: string | null
          procesado: boolean
          rol: string
          telefono: string | null
          texto: string | null
          tipo: string
          wa_message_id: string | null
        }
        Insert: {
          created_at?: string
          descartado?: boolean
          fallido?: boolean
          id?: string
          media_caption?: string | null
          media_filename?: string | null
          media_lat?: number | null
          media_lng?: number | null
          media_mime?: string | null
          media_path?: string | null
          procesado?: boolean
          rol?: string
          telefono?: string | null
          texto?: string | null
          tipo?: string
          wa_message_id?: string | null
        }
        Update: {
          created_at?: string
          descartado?: boolean
          fallido?: boolean
          id?: string
          media_caption?: string | null
          media_filename?: string | null
          media_lat?: number | null
          media_lng?: number | null
          media_mime?: string | null
          media_path?: string | null
          procesado?: boolean
          rol?: string
          telefono?: string | null
          texto?: string | null
          tipo?: string
          wa_message_id?: string | null
        }
        Relationships: []
      }
      pedidos: {
        Row: {
          aclaracion: string | null
          auto_rechazado: boolean
          aviso_precio_sobreescrito: boolean
          cantidad_agua: number
          cantidad_crema: number
          costo_envio: number
          creado_por_nombre: string | null
          created_at: string
          direccion: string
          direccion_de_historial: boolean
          entro_a_cocina_at: string | null
          enviado_at: string | null
          enviado_por_nombre: string | null
          es_cambio_manual: boolean | null
          esperando_respuesta_boton: boolean
          estado: string
          fecha_entrega: string
          id: number
          intentos_reenvio: number
          mensaje_enviado: boolean
          metodo_pago: string
          monto_total_agua: number | null
          monto_total_crema: number | null
          observaciones: string | null
          observaciones_detalle: Json | null
          pagado: boolean | null
          precio_total: number | null
          precio_unitario_agua: number | null
          precio_unitario_crema: number | null
          recordatorio_enviado: boolean
          resumen_pendiente: boolean
          telefono: string
          updated_at: string | null
        }
        Insert: {
          aclaracion?: string | null
          auto_rechazado?: boolean
          aviso_precio_sobreescrito?: boolean
          cantidad_agua?: number
          cantidad_crema?: number
          costo_envio?: number
          creado_por_nombre?: string | null
          created_at?: string
          direccion?: string
          direccion_de_historial?: boolean
          entro_a_cocina_at?: string | null
          enviado_at?: string | null
          enviado_por_nombre?: string | null
          es_cambio_manual?: boolean | null
          esperando_respuesta_boton?: boolean
          estado?: string
          fecha_entrega?: string
          id?: number
          intentos_reenvio?: number
          mensaje_enviado?: boolean
          metodo_pago: string
          monto_total_agua?: number | null
          monto_total_crema?: number | null
          observaciones?: string | null
          observaciones_detalle?: Json | null
          pagado?: boolean | null
          precio_total?: number | null
          precio_unitario_agua?: number | null
          precio_unitario_crema?: number | null
          recordatorio_enviado?: boolean
          resumen_pendiente?: boolean
          telefono: string
          updated_at?: string | null
        }
        Update: {
          aclaracion?: string | null
          auto_rechazado?: boolean
          aviso_precio_sobreescrito?: boolean
          cantidad_agua?: number
          cantidad_crema?: number
          costo_envio?: number
          creado_por_nombre?: string | null
          created_at?: string
          direccion?: string
          direccion_de_historial?: boolean
          entro_a_cocina_at?: string | null
          enviado_at?: string | null
          enviado_por_nombre?: string | null
          es_cambio_manual?: boolean | null
          esperando_respuesta_boton?: boolean
          estado?: string
          fecha_entrega?: string
          id?: number
          intentos_reenvio?: number
          mensaje_enviado?: boolean
          metodo_pago?: string
          monto_total_agua?: number | null
          monto_total_crema?: number | null
          observaciones?: string | null
          observaciones_detalle?: Json | null
          pagado?: boolean | null
          precio_total?: number | null
          precio_unitario_agua?: number | null
          precio_unitario_crema?: number | null
          recordatorio_enviado?: boolean
          resumen_pendiente?: boolean
          telefono?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      reglas_precios: {
        Row: {
          id: number
          lista_id: number
          min_cantidad: number
          precio_unitario: number
          tipo_producto: string
        }
        Insert: {
          id?: number
          lista_id: number
          min_cantidad: number
          precio_unitario: number
          tipo_producto: string
        }
        Update: {
          id?: number
          lista_id?: number
          min_cantidad?: number
          precio_unitario?: number
          tipo_producto?: string
        }
        Relationships: [
          {
            foreignKeyName: "reglas_precios_lista_id_fkey"
            columns: ["lista_id"]
            isOneToOne: false
            referencedRelation: "listas_precios"
            referencedColumns: ["id"]
          },
        ]
      }
      uso_modelo: {
        Row: {
          created_at: string
          id: number
          modelo: string
          telefono: string | null
          tipo: string
          tokens_input: number
          tokens_output: number
          tokens_total: number
        }
        Insert: {
          created_at?: string
          id?: never
          modelo: string
          telefono?: string | null
          tipo: string
          tokens_input?: number
          tokens_output?: number
          tokens_total?: number
        }
        Update: {
          created_at?: string
          id?: never
          modelo?: string
          telefono?: string | null
          tipo?: string
          tokens_input?: number
          tokens_output?: number
          tokens_total?: number
        }
        Relationships: []
      }
    }
    Views: {
      conversaciones_inbox: {
        Row: {
          bloqueado: boolean | null
          motivo_atencion: string | null
          requiere_atencion: boolean | null
          telefono: string | null
          toma_activa: boolean | null
          ultimo_at: string | null
          ultimo_media_caption: string | null
          ultimo_rol: string | null
          ultimo_texto: string | null
          ultimo_tipo: string | null
        }
        Relationships: []
      }
      uso_modelo_diario: {
        Row: {
          dia: string | null
          llamadas: number | null
          modelo: string | null
          tipo: string | null
          tokens_input: number | null
          tokens_output: number | null
          tokens_total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      auto_confirmar_pedidos_expirados: { Args: never; Returns: undefined }
      es_admin: { Args: never; Returns: boolean }
      obtener_actividad_por_dia: {
        Args: { desde: string; hasta: string }
        Returns: {
          acciones: number
          dia: string
          usuario_nombre: string
        }[]
      }
      obtener_balance: {
        Args: { fecha_fin: string; fecha_inicio: string }
        Returns: {
          cantidad_envios: number
          cantidad_gastos: number
          costo_envio_total: number
          efectivo_final: number
          ingreso_total: number
          plata_efectivo: number
          plata_transferencia: number
          total_agua: number
          total_crema: number
          total_gastos: number
        }[]
      }
      obtener_contadores_helados: {
        Args: {
          direccion_filtro?: string
          estados?: string[]
          fecha_desde?: string
          fecha_hasta?: string
          telefono_filtro?: string
        }
        Returns: {
          entregados: number
          total: number
        }[]
      }
      obtener_ranking_actividad: {
        Args: { desde: string; hasta: string }
        Returns: {
          acciones: number
          pedidos_tocados: number
          usuario_id: string
          usuario_nombre: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
