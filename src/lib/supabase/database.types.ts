export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      memberships: {
        Row: {
          org_id: string;
          user_id: string;
          role: "owner" | "admin" | "manager" | "staff";
          all_locations: boolean;
          created_at: string;
        };
        Insert: {
          org_id: string;
          user_id: string;
          role?: "owner" | "admin" | "manager" | "staff";
          all_locations?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["memberships"]["Insert"]>;
        Relationships: [];
      };
      locations: {
        Row: {
          id: string;
          org_id: string;
          name: string;
          kind: string;
          timezone: string;
          day_cutoff: string;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          name: string;
          kind?: string;
          timezone?: string;
          day_cutoff?: string;
          active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["locations"]["Insert"]>;
        Relationships: [];
      };
      suppliers: {
        Row: {
          id: string;
          org_id: string;
          name: string;
          tax_id: string | null;
          email: string | null;
          phone: string | null;
          notes: string | null;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          name: string;
          tax_id?: string | null;
          email?: string | null;
          phone?: string | null;
          notes?: string | null;
          active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["suppliers"]["Insert"]>;
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          org_id: string;
          category_id: string | null;
          name: string;
          dimension: "mass" | "volume" | "count";
          base_unit: string;
          sku: string | null;
          track_stock: boolean;
          active: boolean;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          category_id?: string | null;
          name: string;
          dimension: "mass" | "volume" | "count";
          sku?: string | null;
          track_stock?: boolean;
          active?: boolean;
          notes?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["products"]["Insert"]>;
        Relationships: [];
      };
      product_packs: {
        Row: {
          id: string;
          product_id: string;
          name: string;
          qty_base: number;
          barcode: string | null;
          full_weight_g: number | null;
          empty_weight_g: number | null;
          is_count_default: boolean;
          is_purchase_default: boolean;
          active: boolean;
        };
        Insert: {
          id?: string;
          product_id: string;
          name: string;
          qty_base: number;
          barcode?: string | null;
          full_weight_g?: number | null;
          empty_weight_g?: number | null;
          is_count_default?: boolean;
          is_purchase_default?: boolean;
          active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["product_packs"]["Insert"]>;
        Relationships: [];
      };
      location_products: {
        Row: {
          location_id: string;
          product_id: string;
          min_qty: number;
          par_qty: number;
          default_area_id: string | null;
          active: boolean;
        };
        Insert: {
          location_id: string;
          product_id: string;
          min_qty?: number;
          par_qty?: number;
          default_area_id?: string | null;
          active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["location_products"]["Insert"]>;
        Relationships: [];
      };
      goods_receipts: {
        Row: {
          id: string;
          org_id: string;
          location_id: string;
          supplier_id: string | null;
          doc_number: string | null;
          doc_date: string;
          status: "open" | "closed" | "cancelled";
          attachment_path: string | null;
          created_by: string | null;
          created_at: string;
          posted_by: string | null;
          posted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          location_id: string;
          supplier_id?: string | null;
          doc_number?: string | null;
          doc_date?: string;
          status?: "open" | "closed" | "cancelled";
          attachment_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          posted_by?: string | null;
          posted_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["goods_receipts"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {
      v_stock_valuation: {
        Row: {
          org_id: string;
          location_id: string;
          location_name: string;
          product_id: string;
          product_name: string;
          category_id: string | null;
          category_name: string | null;
          base_unit: string;
          qty: number;
          avg_cost: number;
          stock_value: number;
          min_qty: number | null;
          par_qty: number | null;
          below_min: boolean;
          suggested_order_qty: number;
        };
        Relationships: [];
      };
      v_stock_area_valuation: {
        Row: {
          org_id: string;
          location_id: string;
          area_id: string;
          location_name: string;
          area_name: string;
          product_id: string;
          product_name: string;
          category_id: string | null;
          category_name: string | null;
          base_unit: string;
          qty: number;
          avg_cost: number;
          stock_value: number;
          updated_at: string;
        };
        Relationships: [];
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
