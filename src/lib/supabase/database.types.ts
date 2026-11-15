
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string | null,"org_id": string,"role": Database["public"]['Enums']["member_role"],"token": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email": string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"org_id": string,"role"?: Database["public"]['Enums']["member_role"],"token"?: string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"org_id"?: string,"role"?: Database["public"]['Enums']["member_role"],"token"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitations_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },
            "jobs": {
                  Row: {
                    "attempts": number,"created_at": string,"error": string | null,"finished_at": string | null,"id": string,"progress": NonNullable<Json>,"property_id": string,"requested_by": string | null,"started_at": string | null,"status": Database["public"]['Enums']["job_status"],"type": string,"worker_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"progress"?: NonNullable<Json>,"property_id": string,"requested_by"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"],"type"?: string,"worker_id"?: string | null
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"progress"?: NonNullable<Json>,"property_id"?: string,"requested_by"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"],"type"?: string,"worker_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "jobs_property_id_fkey"
      columns: ["property_id"]
isOneToOne: false
      referencedRelation: "properties"
      referencedColumns: ["id"]
    }
                  ]
                },"levels": {
                  Row: {
                    "ceiling_height": number,"created_at": string,"floorplan_path": string | null,"id": string,"name": string,"plan": Json | null,"property_id": string,"sort": number
                  }
                  ComputedFields: never
                  Insert: {
                    "ceiling_height"?: number,"created_at"?: string,"floorplan_path"?: string | null,"id"?: string,"name": string,"plan"?: Json | null,"property_id": string,"sort"?: number
                  }
                  Update: {
                    "ceiling_height"?: number,"created_at"?: string,"floorplan_path"?: string | null,"id"?: string,"name"?: string,"plan"?: Json | null,"property_id"?: string,"sort"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "levels_property_id_fkey"
      columns: ["property_id"]
isOneToOne: false
      referencedRelation: "properties"
      referencedColumns: ["id"]
    }
                  ]
                },"media": {
                  Row: {
                    "bytes": number | null,"created_at": string,"height": number | null,"hint": string | null,"id": string,"kind": Database["public"]['Enums']["media_kind"],"level_id": string | null,"property_id": string,"room_estimate": Json | null,"room_id": string | null,"room_type": Database["public"]['Enums']["room_type"] | null,"sort": number,"storage_path": string,"width": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bytes"?: number | null,"created_at"?: string,"height"?: number | null,"hint"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["media_kind"],"level_id"?: string | null,"property_id": string,"room_estimate"?: Json | null,"room_id"?: string | null,"room_type"?: Database["public"]['Enums']["room_type"] | null,"sort"?: number,"storage_path": string,"width"?: number | null
                  }
                  Update: {
                    "bytes"?: number | null,"created_at"?: string,"height"?: number | null,"hint"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["media_kind"],"level_id"?: string | null,"property_id"?: string,"room_estimate"?: Json | null,"room_id"?: string | null,"room_type"?: Database["public"]['Enums']["room_type"] | null,"sort"?: number,"storage_path"?: string,"width"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "media_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "media_property_id_fkey"
      columns: ["property_id"]
isOneToOne: false
      referencedRelation: "properties"
      referencedColumns: ["id"]
    }
                  ]
                },"memberships": {
                  Row: {
                    "created_at": string,"org_id": string,"role": Database["public"]['Enums']["member_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"org_id": string,"role"?: Database["public"]['Enums']["member_role"],"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"org_id"?: string,"role"?: Database["public"]['Enums']["member_role"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"organizations": {
                  Row: {
                    "created_at": string,"id": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"properties": {
                  Row: {
                    "address": string | null,"area": string | null,"bathrooms": number | null,"bedrooms": number | null,"city": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description": string | null,"id": string,"kind": Database["public"]['Enums']["property_kind"],"lat": number | null,"lng": number | null,"org_id": string,"start_floor": number,"status": Database["public"]['Enums']["property_status"],"title": string,"total_area_m2": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"area"?: string | null,"bathrooms"?: number | null,"bedrooms"?: number | null,"city"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["property_kind"],"lat"?: number | null,"lng"?: number | null,"org_id": string,"start_floor"?: number,"status"?: Database["public"]['Enums']["property_status"],"title": string,"total_area_m2"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"area"?: string | null,"bathrooms"?: number | null,"bedrooms"?: number | null,"city"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["property_kind"],"lat"?: number | null,"lng"?: number | null,"org_id"?: string,"start_floor"?: number,"status"?: Database["public"]['Enums']["property_status"],"title"?: string,"total_area_m2"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "properties_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"tours": {
                  Row: {
                    "created_at": string,"id": string,"is_current": boolean,"job_id": string | null,"plan_paths": NonNullable<Json>,"property_id": string,"tour_path": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_current"?: boolean,"job_id"?: string | null,"plan_paths"?: NonNullable<Json>,"property_id": string,"tour_path": string,"version": number
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_current"?: boolean,"job_id"?: string | null,"plan_paths"?: NonNullable<Json>,"property_id"?: string,"tour_path"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "tours_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tours_property_id_fkey"
      columns: ["property_id"]
isOneToOne: false
      referencedRelation: "properties"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
"accept_invitation":
{ Args: { "p_token": string }; Returns: string
                           },
"create_workspace":
{ Args: { "p_name": string }; Returns: string
                           },
"get_invitation":
{ Args: { "p_token": string }; Returns: {
              "org_id": string,
"org_name": string,
"email": string,
"role": Database["public"]['Enums']["member_role"],
"inviter_email": string | null,
"status": string
            }[]
                           },
"is_org_owner":
{ Args: { "org": string }; Returns: boolean
                           },
"list_workspace_members":
{ Args: { "p_org": string }; Returns: {
              "user_id": string,
"email": string,
"role": Database["public"]['Enums']["member_role"],
"joined_at": string
            }[]
                           },
            "claim_next_job":
{ Args: { "p_worker": string }; Returns: {
              "attempts": number,
"created_at": string,
"error": string | null,
"finished_at": string | null,
"id": string,
"progress": NonNullable<Json>,
"property_id": string,
"requested_by": string | null,
"started_at": string | null,
"status": Database["public"]['Enums']["job_status"],
"type": string,
"worker_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "jobs"
        isOneToOne: false
        isSetofReturn: true
      } },
"is_org_member":
{ Args: { "org": string }; Returns: boolean
                           },
"soft_delete_property":
{ Args: { "p_id": string }; Returns: undefined
                           }
          }
          Enums: {
            "job_status": "queued"|"running"|"succeeded"|"failed","media_kind": "photo"|"floorplan","member_role": "owner"|"editor","property_kind": "apartment"|"house"|"studio"|"maisonette"|"villa"|"other","property_status": "draft"|"processing"|"ready"|"published","room_type": "living"|"kitchen"|"dining"|"bedroom"|"bathroom"|"hallway"|"office"|"storage"|"stairs"|"balcony"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "job_status": ["queued", "running", "succeeded", "failed"],"media_kind": ["photo", "floorplan"],"member_role": ["owner", "editor"],"property_kind": ["apartment", "house", "studio", "maisonette", "villa", "other"],"property_status": ["draft", "processing", "ready", "published"],"room_type": ["living", "kitchen", "dining", "bedroom", "bathroom", "hallway", "office", "storage", "stairs", "balcony"]
          }
        }
} as const
