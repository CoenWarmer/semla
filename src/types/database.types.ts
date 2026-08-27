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
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      context_inspections: {
        Row: {
          created_at: string
          id: string
          result: Json
          semla_session_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          result: Json
          semla_session_id: string
        }
        Update: {
          created_at?: string
          id?: string
          result?: Json
          semla_session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "context_inspections_semla_session_id_fkey"
            columns: ["semla_session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      pi_session_entries: {
        Row: {
          created_at: string
          event_type: string
          id: string
          parent_entry_id: string | null
          payload: Json
          pi_session_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id: string
          parent_entry_id?: string | null
          payload: Json
          pi_session_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          parent_entry_id?: string | null
          payload?: Json
          pi_session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pi_session_entries_parent_entry_id_fkey"
            columns: ["parent_entry_id"]
            isOneToOne: false
            referencedRelation: "pi_session_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pi_session_entries_pi_session_id_fkey"
            columns: ["pi_session_id"]
            isOneToOne: false
            referencedRelation: "pi_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      pi_sessions: {
        Row: {
          active_leaf_entry_id: string | null
          created_at: string
          id: string
          model_id: string | null
          model_provider: string | null
          semla_session_id: string
          updated_at: string
          workspace_root: string
        }
        Insert: {
          active_leaf_entry_id?: string | null
          created_at?: string
          id?: string
          model_id?: string | null
          model_provider?: string | null
          semla_session_id: string
          updated_at?: string
          workspace_root?: string
        }
        Update: {
          active_leaf_entry_id?: string | null
          created_at?: string
          id?: string
          model_id?: string | null
          model_provider?: string | null
          semla_session_id?: string
          updated_at?: string
          workspace_root?: string
        }
        Relationships: [
          {
            foreignKeyName: "pi_sessions_active_leaf_entry_id_fkey"
            columns: ["active_leaf_entry_id"]
            isOneToOne: false
            referencedRelation: "pi_session_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pi_sessions_semla_session_id_fkey"
            columns: ["semla_session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          created_at: string
          goal: string | null
          id: string
          title: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          goal?: string | null
          id?: string
          title?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          goal?: string | null
          id?: string
          title?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          default_model_id: string | null
          default_model_provider: string | null
          system_prompt: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          default_model_id?: string | null
          default_model_provider?: string | null
          system_prompt?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          default_model_id?: string | null
          default_model_provider?: string | null
          system_prompt?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      workflow_runs: {
        Row: {
          created_at: string
          error: string | null
          id: string
          mode: string
          result: Json | null
          run_id: string
          semla_session_id: string
          snapshot: Json
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          id?: string
          mode: string
          result?: Json | null
          run_id: string
          semla_session_id: string
          snapshot?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          id?: string
          mode?: string
          result?: Json | null
          run_id?: string
          semla_session_id?: string
          snapshot?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_runs_semla_session_id_fkey"
            columns: ["semla_session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
